import { useState, type FormEvent } from 'react';
import { ChefHat, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react';
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
          <div className="login-kicker"><ChefHat size={17} /> Quản lý vận hành</div>
          <h1>Vận hành nhà hàng<br />trong một màn hình.</h1>
          <p>Quản lý bàn, gọi món, hàng chờ bếp và thanh toán theo thời gian thực.</p>
          <div className="login-feature-list">
            <span><ShieldCheck size={18} /> Dữ liệu vận hành luôn đồng bộ</span>
            <span><ShieldCheck size={18} /> Hàng đợi bếp FIFO minh bạch</span>
            <span><ShieldCheck size={18} /> Giá và thời gian nấu nhất quán</span>
          </div>
        </div>
        <span className="login-showcase-footer">CAS · Core Advanced Solutions</span>
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
              <ShieldCheck size={17} />
              <span>{error}</span>
            </div>
          )}

          <button className="login-submit" type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? <><span className="login-spinner" /> Đang xác thực…</> : <>Đăng nhập <span aria-hidden="true">→</span></>}
          </button>

          <p className="login-security-note"><ShieldCheck size={14} /> Phiên đăng nhập chỉ được lưu trong tab trình duyệt này.</p>
        </form>
      </section>
    </main>
  );
}
