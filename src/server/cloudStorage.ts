import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { getAllSettings } from './db.js';
import {
  RCLONE_FOLDER_REGEX,
  RCLONE_REMOTE_REGEX,
  validateCloudEndpointUrl,
} from './security.js';

const execFileAsync = promisify(execFile);

export type CloudProvider = 'none' | 's3' | 'r2' | 'b2' | 'gdrive';

export interface CloudConfig {
  provider: CloudProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  rcloneRemote: string;
  rcloneFolder: string;
  autoUpload: boolean;
}

export function getCloudConfig(): CloudConfig {
  const s = getAllSettings();
  const rawProvider = (s.cloud_provider || 'none') as CloudProvider;
  const provider: CloudProvider = ['none', 's3', 'r2', 'b2', 'gdrive'].includes(rawProvider)
    ? rawProvider
    : 'none';
  return {
    provider,
    endpoint: (s.cloud_endpoint || '').trim(),
    region: (s.cloud_region || 'auto').trim() || 'auto',
    bucket: (s.cloud_bucket || '').trim(),
    accessKey: (s.cloud_access_key || '').trim(),
    secretKey: s.cloud_secret_key || '',
    rcloneRemote: (s.cloud_rclone_remote || '').trim(),
    rcloneFolder: (s.cloud_rclone_folder || 'fbbahi-backups').trim() || 'fbbahi-backups',
    autoUpload: s.cloud_auto_upload === '1',
  };
}

export function isCloudConfigured(cfg = getCloudConfig()): boolean {
  if (cfg.provider === 'none') return false;
  if (cfg.provider === 'gdrive') {
    return (
      RCLONE_REMOTE_REGEX.test(cfg.rcloneRemote) && RCLONE_FOLDER_REGEX.test(cfg.rcloneFolder)
    );
  }
  return Boolean(cfg.bucket && cfg.accessKey && cfg.secretKey);
}

function buildS3Client(cfg: CloudConfig): S3Client {
  if (cfg.endpoint && !validateCloudEndpointUrl(cfg.endpoint)) {
    throw new Error('Invalid or private Cloud S3 endpoint URL (must use HTTPS).');
  }
  return new S3Client({
    region: cfg.provider === 'r2' ? 'auto' : cfg.region || 'us-east-1',
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    forcePathStyle: cfg.provider === 'b2' || cfg.provider === 'r2' || Boolean(cfg.endpoint),
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
  });
}

export async function testCloudConnection(): Promise<{ ok: boolean; message: string }> {
  const cfg = getCloudConfig();
  if (cfg.provider === 'none') {
    throw new Error('Select a Cloud Storage Provider (S3, R2, B2, or Google Drive via rclone) first.');
  }

  if (cfg.provider === 'gdrive') {
    if (!RCLONE_REMOTE_REGEX.test(cfg.rcloneRemote)) {
      throw new Error('Invalid rclone remote name (letters, numbers, _, -).');
    }
    if (!RCLONE_FOLDER_REGEX.test(cfg.rcloneFolder)) {
      throw new Error('Invalid rclone folder path.');
    }
    try {
      await execFileAsync('rclone', ['lsd', `${cfg.rcloneRemote}:`], { timeout: 15000 });
      return { ok: true, message: `Connected to Google Drive rclone remote '${cfg.rcloneRemote}:'` };
    } catch (err) {
      throw new Error(
        `rclone check failed: ${
          err instanceof Error ? err.message : 'Ensure rclone is installed and remote is authorized.'
        }`
      );
    }
  }

  if (!cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
    throw new Error('Bucket name, Access Key ID, and Secret Access Key are required.');
  }

  const client = buildS3Client(cfg);
  await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
  return {
    ok: true,
    message: `Verified ${cfg.provider.toUpperCase()} bucket '${cfg.bucket}' is reachable.`,
  };
}

export async function uploadBackupToCloud(
  localFilePath: string,
  remoteKey: string
): Promise<{ provider: CloudProvider; key: string }> {
  const cfg = getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    throw new Error('Cloud backup storage is not configured.');
  }
  if (!fs.existsSync(localFilePath)) {
    throw new Error('Local backup file not found for cloud upload.');
  }

  if (cfg.provider === 'gdrive') {
    const cleanKey = remoteKey.replace(/^\/+/, '');
    const destTarget = `${cfg.rcloneRemote}:${cfg.rcloneFolder.replace(/\/+$/, '')}/${cleanKey}`;
    await execFileAsync('rclone', ['copyto', localFilePath, destTarget], { timeout: 300000 });
    return { provider: 'gdrive', key: destTarget };
  }

  const client = buildS3Client(cfg);
  const stream = fs.createReadStream(localFilePath);
  const cleanKey = remoteKey.replace(/^\/+/, '');
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: cleanKey,
      Body: stream,
      ContentType: localFilePath.endsWith('.zip') ? 'application/zip' : 'application/gzip',
    })
  );
  return { provider: cfg.provider, key: cleanKey };
}

export async function downloadBackupFromCloud(
  provider: string,
  cloudKey: string,
  destLocalPath: string
): Promise<void> {
  if (!provider || provider === 'local' || provider === 'none' || !cloudKey) {
    throw new Error('No remote cloud copy exists for this backup.');
  }

  const cfg = getCloudConfig();
  fs.mkdirSync(path.dirname(destLocalPath), { recursive: true });

  if (provider === 'gdrive') {
    await execFileAsync('rclone', ['copyto', cloudKey, destLocalPath], { timeout: 300000 });
    return;
  }

  if (!cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
    throw new Error('S3/R2/B2 credentials are missing in Panel Settings to pull cloud backup.');
  }

  const client = buildS3Client(cfg);
  const resp = await client.send(
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: cloudKey,
    })
  );
  if (!resp.Body) {
    throw new Error('Cloud object returned empty body.');
  }
  await pipeline(resp.Body as Readable, fs.createWriteStream(destLocalPath));
}

export async function deleteBackupFromCloud(provider: string, cloudKey: string): Promise<void> {
  if (!provider || provider === 'local' || provider === 'none' || !cloudKey) return;
  const cfg = getCloudConfig();

  if (provider === 'gdrive') {
    await execFileAsync('rclone', ['deletefile', cloudKey], { timeout: 30000 }).catch(() => {});
    return;
  }

  if (!cfg.bucket || !cfg.accessKey || !cfg.secretKey) return;
  const client = buildS3Client(cfg);
  await client
    .send(
      new DeleteObjectCommand({
        Bucket: cfg.bucket,
        Key: cloudKey,
      })
    )
    .catch(() => {});
}
