"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import QRCode from "qrcode";

interface RemoteHost {
  url: string;
  ip: string;
  port: number;
}

interface RemoteInfo {
  enabled: boolean;
  authRequired?: boolean;
  username?: string;
  password?: string;
  error?: string;
  hosts: RemoteHost[];
}

export function RemoteAccessQR() {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedHost, setSelectedHost] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [username, setUsername] = useState("ao");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const req = globalThis.fetch?.("/api/remote-info");
    if (!req || typeof (req as PromiseLike<unknown>).then !== "function") {
      return;
    }
    req
      .then((r) => r.json())
      .then((data: RemoteInfo) => {
        if (!cancelled) {
          setInfo(data);
          setUsername(data.username ?? "ao");
          setPassword(data.password ?? "");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const setRemoteEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/remote-info", { method: enabled ? "POST" : "DELETE" });
      const data = (await res.json()) as RemoteInfo;
      if (!res.ok) throw new Error(data.error ?? "Remote access update failed");
      setInfo(data);
      setUsername(data.username ?? "ao");
      setPassword(data.password ?? "");
      setSelectedHost(0);
      if (enabled) setOpen(true);
      else setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remote access update failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const saveCredentials = useCallback(async () => {
    setSavingCredentials(true);
    setError(null);
    try {
      const res = await fetch("/api/remote-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as RemoteInfo;
      if (!res.ok) throw new Error(data.error ?? "Remote credential update failed");
      setInfo(data);
      setUsername(data.username ?? "ao");
      setPassword(data.password ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remote credential update failed");
    } finally {
      setSavingCredentials(false);
    }
  }, [username, password]);

  const enabled = info?.enabled === true;
  const hosts = info?.hosts ?? [];
  const host = hosts[selectedHost] ?? hosts[0];
  const hasMultiple = hosts.length > 1;

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    if (!host?.url) return;

    QRCode.toDataURL(host.url, {
      width: 200,
      margin: 2,
      errorCorrectionLevel: "M",
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [host?.url]);

  return (
    <>
      <button
        type="button"
        className="dashboard-app-btn topbar-desktop-only"
        onClick={() => {
          if (enabled) toggle();
          else void setRemoteEnabled(true);
        }}
        aria-label={enabled ? "Show QR code for remote access" : "Enable remote access"}
        title={enabled ? "Remote access" : "Enable remote access"}
        disabled={busy}
      >
        <svg
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="3" height="3" rx="0.5" />
          <rect x="18" y="18" width="3" height="3" rx="0.5" />
          <rect x="18" y="14" width="3" height="3" rx="0.5" />
          <rect x="14" y="18" width="3" height="3" rx="0.5" />
        </svg>
        <span className="hidden sm:inline">{busy ? "Remote..." : "Remote"}</span>
      </button>
      {error ? <span className="remote-qr-error">{error}</span> : null}

      {open && enabled ? (
        <div className="remote-qr-overlay" onClick={toggle}>
          <div className="remote-qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="remote-qr-modal__header">
              <h2 className="remote-qr-modal__title">Scan to access dashboard</h2>
              <button
                type="button"
                className="remote-qr-modal__close"
                onClick={toggle}
                aria-label="Close"
              >
                <svg
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="remote-qr-modal__body">
              {qrDataUrl && host ? (
                <Image
                  src={qrDataUrl}
                  alt={`QR code for ${host.url}`}
                  className="remote-qr-modal__qr"
                  width={200}
                  height={200}
                  unoptimized
                />
              ) : null}

              <p className="remote-qr-modal__url">{host?.url}</p>

              {hasMultiple ? (
                <div className="remote-qr-modal__hosts">
                  {hosts.map((h, i) => (
                    <button
                      key={h.ip}
                      type="button"
                      className={`remote-qr-modal__host-btn${i === selectedHost ? " remote-qr-modal__host-btn--active" : ""}`}
                      onClick={() => setSelectedHost(i)}
                    >
                      {h.ip}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="remote-qr-modal__credentials">
                <label className="remote-qr-modal__credential-field">
                  <span>Username</span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    className="remote-qr-modal__input"
                  />
                </label>
                <label className="remote-qr-modal__credential-field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className="remote-qr-modal__input"
                  />
                </label>
                <button
                  type="button"
                  className="remote-qr-modal__save"
                  onClick={() => void saveCredentials()}
                  disabled={savingCredentials || !username.trim() || !password.trim()}
                >
                  {savingCredentials ? "Saving..." : "Save credentials"}
                </button>
              </div>

              <button
                type="button"
                className="remote-qr-modal__disable"
                onClick={() => void setRemoteEnabled(false)}
                disabled={busy}
              >
                Disable remote access
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
