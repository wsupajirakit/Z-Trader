import { useLayoutEffect, useRef } from 'react';
import { useLogLines } from './ActivityLogContext';

/** 📜 System Log pane — always scrolled to the newest line. */
export function SystemLog() {
  const { lines } = useLogLines();
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="log" ref={ref} role="log">
      {lines.map((l) => (
        <div key={l.key}>
          <span className="t">[{l.time}]</span>
          {l.tag ? (
            <>
              <span className="mtag">{l.tag}</span>{' '}
            </>
          ) : null}
          <span className={`lv-${l.level}`}>{l.message}</span>
        </div>
      ))}
    </div>
  );
}
