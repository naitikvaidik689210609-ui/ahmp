import { AlertTriangle, CheckCircle2, KeyRound, Lock, Mail, ShieldCheck, Smartphone, User } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AuthUser, PanelAppearance, PanelBranding } from '../types';

interface LoginViewProps {
  needsSetup: boolean;
  allowPublicRegistration: boolean;
  registrationMode: 'instant' | 'approval';
  maintenanceMode: boolean;
  maintenanceMessage: string;
  branding: PanelBranding;
  appearance?: PanelAppearance;
  onSuccess: (token: string, user: AuthUser) => void;
}

export function LoginView({
  needsSetup,
  allowPublicRegistration,
  registrationMode,
  maintenanceMode,
  maintenanceMessage,
  branding,
  appearance,
  onSuccess,
}: LoginViewProps) {
  const [mode, setMode] = useState<'setup' | 'login' | 'register'>(needsSetup ? 'setup' : 'login');
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [requires2fa, setRequires2fa] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);
  const [maintenanceLocked, setMaintenanceLocked] = useState(false);

  useEffect(() => {
    if (needsSetup) {
      setMode('setup');
    } else if (!allowPublicRegistration && mode === 'register') {
      setMode('login');
    }
  }, [needsSetup, allowPublicRegistration, mode]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPendingNotice(null);
    setMaintenanceLocked(false);

    if (mode === 'setup' || mode === 'register') {
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === 'setup') {
        const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/setup', {
          method: 'POST',
          body: JSON.stringify({ username, email, password }),
        });
        onSuccess(res.token, res.user);
      } else if (mode === 'register') {
        const res = await apiFetch<{
          pendingApproval: boolean;
          message?: string;
          token?: string;
          user?: AuthUser;
        }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, email, password, confirmPassword }),
        });

        if (res.pendingApproval) {
          setPendingNotice(
            res.message ||
              'Account created! An Owner or Admin must approve your membership before you can sign in.'
          );
          setUsername('');
          setEmail('');
          setPassword('');
          setConfirmPassword('');
          setMode('login');
          return;
        }
        if (res.token && res.user) {
          onSuccess(res.token, res.user);
        }
      } else {
        const res = await apiFetch<{
          token?: string;
          user?: AuthUser;
          requires2fa?: boolean;
        }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ identifier, password, totpCode: requires2fa ? totpCode : undefined }),
        });

        if (res.requires2fa) {
          setRequires2fa(true);
          return;
        }
        if (res.token && res.user) {
          onSuccess(res.token, res.user);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed.';
      if (msg.toLowerCase().includes('maintenance')) {
        setMaintenanceLocked(true);
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[var(--bg-base)] px-4 py-12">
      {appearance?.bgUrl && appearance.bgType !== 'none' && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
          {appearance.bgType === 'video' ? (
            <video
              key={appearance.bgUrl}
              src={appearance.bgUrl}
              autoPlay
              loop
              muted
              playsInline
              className="h-full w-full object-cover"
              style={{ opacity: appearance.bgOpacity }}
            />
          ) : (
            <img
              key={appearance.bgUrl}
              src={appearance.bgUrl}
              alt=""
              className="h-full w-full object-cover"
              style={{ opacity: appearance.bgOpacity }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-[#070510]/65 via-[#090714]/55 to-[#070510]/80" />
        </div>
      )}

      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
        style={{
          background:
            'radial-gradient(circle at 22% 18%, rgba(var(--accent-rgb), 0.16), transparent 45%), radial-gradient(circle at 80% 78%, rgba(var(--accent-soft-rgb), 0.12), transparent 42%)',
        }}
      />

      <div className="cyber-glass relative w-full max-w-md rounded-2xl p-8">
        <div className="mb-6 flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/40 bg-violet-600/20 text-violet-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">{branding.panelName}</h1>
            <p className="text-sm text-slate-400">{branding.panelSubtitle}</p>
          </div>
        </div>

        {(maintenanceMode || maintenanceLocked) && (
          <div className="mb-5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>FB BAHI Panel Under Maintenance</span>
            </div>
            <p className="mt-1 text-xs text-amber-200/80">{maintenanceMessage}</p>
            <p className="mt-1 text-xs text-amber-300/70">
              Owner and Admin accounts may still sign in below.
            </p>
          </div>
        )}

        {!needsSetup && allowPublicRegistration && (
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-violet-500/20 bg-[#090714]/80 p-1">
            <button
              type="button"
              onClick={() => {
                setError(null);
                setRequires2fa(false);
                setMode('login');
              }}
              className={`rounded-lg py-2 text-xs font-semibold transition-colors ${
                mode === 'login' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setPendingNotice(null);
                setRequires2fa(false);
                setMode('register');
              }}
              className={`rounded-lg py-2 text-xs font-semibold transition-colors ${
                mode === 'register' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>
        )}

        <div className="mb-5 border-b border-violet-500/15 pb-4">
          <h2 className="text-lg font-semibold text-white">
            {mode === 'setup'
              ? 'Claim Owner Account'
              : mode === 'register'
              ? 'Register Member Account'
              : requires2fa
              ? 'Two-Factor Verification'
              : 'Sign in to Control Panel'}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            {mode === 'setup'
              ? 'No administrator exists yet. Create the initial owner account to lock setup.'
              : mode === 'register'
              ? registrationMode === 'approval'
                ? 'New registrations require Owner/Admin approval before activation.'
                : 'Create your panel account with instant starter resource quota.'
              : requires2fa
              ? 'Enter the 6-digit code from your authenticator app.'
              : 'Enter your credentials to access servers and virtual machines.'}
          </p>
        </div>

        {pendingNotice && (
          <div
            role="status"
            className="mb-5 flex items-start gap-2.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>{pendingNotice}</span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-5 rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'setup' || mode === 'register' ? (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">Username</label>
                <div className="relative">
                  <User className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={mode === 'setup' ? 'admin' : 'choose_username'}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 py-2.5 pr-3.5 pl-10 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">Email Address</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 py-2.5 pr-3.5 pl-10 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>
            </>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Username or Email
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="admin or owner@example.com"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 py-2.5 pr-3.5 pl-10 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
              </div>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">Password</label>
            <div className="relative">
              <Lock className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 py-2.5 pr-3.5 pl-10 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
              />
            </div>
          </div>

          {requires2fa && mode === 'login' && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Authenticator Code (2FA)
              </label>
              <div className="relative">
                <Smartphone className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-violet-400" />
                <input
                  type="text"
                  required
                  autoFocus
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="6-digit TOTP code"
                  className="w-full rounded-lg border border-violet-500/40 bg-[#090714]/80 py-2.5 pr-3.5 pl-10 font-mono text-sm tracking-widest text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
              </div>
            </div>
          )}

          {(mode === 'setup' || mode === 'register') && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Confirm Password
              </label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 py-2.5 pr-3.5 pl-10 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="cyber-glow-btn mt-2 w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading
              ? 'Please wait...'
              : mode === 'setup'
              ? 'Create Owner Account'
              : mode === 'register'
              ? 'Create Member Account'
              : requires2fa
              ? 'Verify & Sign In'
              : 'Sign In'}
          </button>
        </form>

        {needsSetup && (
          <div className="mt-5 border-t border-violet-500/15 pt-4 text-center">
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode(mode === 'setup' ? 'login' : 'setup');
              }}
              className="text-xs font-medium text-violet-300 hover:text-violet-200"
            >
              {mode === 'setup'
                ? 'Already created via CLI? Switch to Sign In'
                : 'Need to initialize first owner? Switch to Setup'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
