import { useState, type FormEvent } from 'react';
import { AlertCircle, ChefHat, Eye, EyeOff, LockKeyhole, UserRound } from 'lucide-react';
import { BRAND_ASSETS } from '../config/restaurant';

interface LoginPageProps {
  busy: boolean;
  error: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
}

export function LoginPage({ busy, error, onLogin }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password || busy) return;
    await onLogin(username.trim(), password);
  };

  return (
    <main className="login-page">
      <div className="login-orb login-orb-one" aria-hidden="true" />
      <div className="login-orb login-orb-two" aria-hidden="true" />

      <section className="login-showcase" aria-label="Giới thiệu CAS POS">
        <img className="login-showcase-logo" src={BRAND_ASSETS.logoHorizontalWhite} alt="CAS" />
        <div className="login-showcase-content">
          <div className="login-kicker"><ChefHat size={17} /> Dành cho nhân viên</div>
          <h1>CAS đồng hành<br />cùng mỗi ca phục vụ.</h1>
          <p>Đăng nhập để bắt đầu làm việc.</p>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={handleSubmit} noValidate>
          <div className="login-mobile-brand">
            <img src={BRAND_ASSETS.logoStacked} alt="CAS" />
          </div>
          <div className="login-lock"><LockKeyhole size={22} /></div>
          <div className="login-heading">
            <span>CAS Restaurant POS</span>
            <h2>Chào mừng trở lại</h2>
            <p>Đăng nhập để tiếp tục phiên vận hành.</p>
          </div>

          <label className="login-field">
            <span>Tên đăng nhập</span>
            <div className="login-input-wrap">
              <UserRound size={18} aria-hidden="true" />
              <input
                autoComplete="username"
                autoFocus
                value={username}
                onChange={event => setUsername(event.target.value)}
                placeholder="Nhập tên đăng nhập"
                aria-invalid={Boolean(error)}
              />
            </div>
          </label>

          <label className="login-field">
            <span>Mật khẩu</span>
            <div className="login-input-wrap">
              <LockKeyhole size={18} aria-hidden="true" />
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="Nhập mật khẩu"
                aria-invalid={Boolean(error)}
              />
              <button
                className="login-password-toggle"
                type="button"
                onClick={() => setShowPassword(value => !value)}
                aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          {error && (
            <div className="login-error" role="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
            </div>
          )}

          <button className="login-submit" type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? <><span className="login-spinner" /> Đang xác thực…</> : <>Đăng nhập <span aria-hidden="true">→</span></>}
          </button>
        </form>
      </section>
    </main>
  );
}
