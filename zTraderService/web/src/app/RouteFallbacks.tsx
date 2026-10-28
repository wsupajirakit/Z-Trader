import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { describeError } from '../api/client';

export function NotFound() {
  return (
    <main className="page">
      <div className="card">
        <h2>ไม่พบหน้านี้</h2>
        <Link to="/">← กลับหน้า dashboard</Link>
      </div>
    </main>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <main className="page">
      <div className="card">
        <h2>เกิดข้อผิดพลาด</h2>
        <p className="muted mb10">{describeError(error)}</p>
        <button type="button" className="btn-inline" onClick={reset}>
          ลองใหม่
        </button>
      </div>
    </main>
  );
}
