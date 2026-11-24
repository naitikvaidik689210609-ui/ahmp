import cron, { type ScheduledTask } from 'node-cron';
import { db, recordAuditLog } from '../db.js';
import {
  controlMinecraftServer,
  createMinecraftBackup,
  sendMinecraftCommand,
} from './dockerController.js';
import { createIncusBackupOrSnapshot } from './incusController.js';

export interface ScheduleRow {
  id: number;
  server_id: number;
  name: string;
  cron_expr: string;
  action: 'restart' | 'backup' | 'command';
  payload: string;
  retention_count: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

export interface IncusScheduleRow {
  id: number;
  instance_id: number;
  name: string;
  cron_expr: string;
  action: 'snapshot' | 'local_backup';
  retention_count: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

const activeMcTasks = new Map<number, ScheduledTask>();
const activeIncusTasks = new Map<number, ScheduledTask>();

export async function executeSchedule(schedule: ScheduleRow): Promise<void> {
  db.prepare(`UPDATE minecraft_schedules SET last_run_at = datetime('now') WHERE id = ?`).run(
    schedule.id
  );

  try {
    if (schedule.action === 'restart') {
      await controlMinecraftServer({
        id: schedule.server_id,
        action: 'restart',
        userId: 0,
        username: 'scheduler',
        ipAddress: '127.0.0.1',
      });
    } else if (schedule.action === 'backup') {
      await createMinecraftBackup({
        serverId: schedule.server_id,
        name: schedule.name,
        backupType: 'scheduled',
        createdBy: 'scheduler',
        retentionCount: schedule.retention_count || 7,
      });
    } else if (schedule.action === 'command' && schedule.payload.trim()) {
      await sendMinecraftCommand(schedule.server_id, schedule.payload.trim());
      recordAuditLog({
        userId: null,
        username: 'scheduler',
        action: 'minecraft.scheduled_command',
        target: `server#${schedule.server_id}`,
        details: schedule.payload.trim().slice(0, 120),
        ipAddress: '127.0.0.1',
      });
    }
  } catch (err) {
    recordAuditLog({
      userId: null,
      username: 'scheduler',
      action: 'minecraft.schedule_error',
      target: `server#${schedule.server_id}`,
      details: `${schedule.name}: ${err instanceof Error ? err.message : 'Execution failed'}`,
      ipAddress: '127.0.0.1',
    });
  }
}

export async function executeIncusSchedule(schedule: IncusScheduleRow): Promise<void> {
  db.prepare(`UPDATE incus_schedules SET last_run_at = datetime('now') WHERE id = ?`).run(
    schedule.id
  );

  try {
    await createIncusBackupOrSnapshot({
      instanceId: schedule.instance_id,
      kind: schedule.action === 'local_backup' ? 'archive' : 'snapshot',
      backupType: 'scheduled',
      createdBy: 'scheduler',
      retentionCount: schedule.retention_count || 7,
    });
  } catch (err) {
    recordAuditLog({
      userId: null,
      username: 'scheduler',
      action: 'incus.schedule_error',
      target: `instance#${schedule.instance_id}`,
      details: `${schedule.name}: ${err instanceof Error ? err.message : 'Execution failed'}`,
      ipAddress: '127.0.0.1',
    });
  }
}

export function registerScheduleTask(row: ScheduleRow): void {
  unregisterScheduleTask(row.id);
  if (!row.enabled || !cron.validate(row.cron_expr)) {
    return;
  }

  const task = cron.schedule(row.cron_expr, () => {
    void executeSchedule(row);
  });
  activeMcTasks.set(row.id, task);
}

export function unregisterScheduleTask(scheduleId: number): void {
  const existing = activeMcTasks.get(scheduleId);
  if (existing) {
    existing.stop();
    activeMcTasks.delete(scheduleId);
  }
}

export function unregisterServerSchedules(serverId: number): void {
  const rows = db
    .prepare('SELECT id FROM minecraft_schedules WHERE server_id = ?')
    .all(serverId) as Array<{ id: number }>;
  for (const r of rows) {
    unregisterScheduleTask(r.id);
  }
}

export function registerIncusScheduleTask(row: IncusScheduleRow): void {
  unregisterIncusScheduleTask(row.id);
  if (!row.enabled || !cron.validate(row.cron_expr)) {
    return;
  }

  const task = cron.schedule(row.cron_expr, () => {
    void executeIncusSchedule(row);
  });
  activeIncusTasks.set(row.id, task);
}

export function unregisterIncusScheduleTask(scheduleId: number): void {
  const existing = activeIncusTasks.get(scheduleId);
  if (existing) {
    existing.stop();
    activeIncusTasks.delete(scheduleId);
  }
}

export function unregisterInstanceSchedules(instanceId: number): void {
  const rows = db
    .prepare('SELECT id FROM incus_schedules WHERE instance_id = ?')
    .all(instanceId) as Array<{ id: number }>;
  for (const r of rows) {
    unregisterIncusScheduleTask(r.id);
  }
}

export function initializeAllSchedules(): void {
  const mcRows = db
    .prepare('SELECT * FROM minecraft_schedules WHERE enabled = 1')
    .all() as ScheduleRow[];
  for (const row of mcRows) {
    registerScheduleTask(row);
  }

  const incusRows = db
    .prepare('SELECT * FROM incus_schedules WHERE enabled = 1')
    .all() as IncusScheduleRow[];
  for (const row of incusRows) {
    registerIncusScheduleTask(row);
  }
}
