import React, { useEffect, useState } from "react";
import type { ConnectState, EngineStatus, ModelDTO } from "../../../shared/protocol";
import { useT } from "../i18n";
import { Modal } from "./common";
import { providerMark } from "./icons";
import { StudioIcon } from "./StudioIcon";

export function ProviderCards({ status, models, connect, onManage }: { status: EngineStatus | null; models: ModelDTO[]; connect: ConnectState; onManage: () => void }): React.ReactElement {
  const t = useT();
  const [providers, setProviders] = useState<{ id: string; label: string; all: { id: string; label: string }[] } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!window.onflip.providerGet) {
      setError(t("studioProvidersUnavailable"));
      return;
    }
    void window.onflip.providerGet().then((p) => { if (alive) setProviders(p); }).catch((e: Error) => { if (alive) setError(e.message || t("studioProvidersUnavailable")); });
    return () => { alive = false; };
  }, []);
  if (!providers) return error ? <div className="msg-error">{error}</div> : <div className="content-loading"><span className="spinner" /></div>;
  const activeId = status?.provider ?? providers.id;
  const label = connect === "connecting" ? t("connecting") : connect === "error" ? t("engineError") : connect === "signed-out" || !status?.signedIn ? t("signedOut") : t("connected");
  return <><div className="provider-card-grid">{providers.all.map((p) => {
    const active = p.id === activeId;
    const Mark = providerMark(p.id);
    return <article key={p.id} className={`provider-card${active ? " active" : ""}`}>
      <div className="provider-card-head"><span className="provider-card-mark"><Mark size={27} /></span><div><h4>{p.label}</h4><small>{active ? t("studioProviderActive") : t("studioProviderOther")}</small></div>{active && <span className={`studio-badge${status?.signedIn && connect === "ready" ? "" : " muted"}`}>{label}</span>}</div>
      <div className="provider-card-model"><span>{t("menuModel")}</span><strong>{active ? models.find((model) => model.slug === status?.model)?.label || status?.model || "—" : "—"}</strong></div>
      <div className="provider-card-foot"><small>{active ? status?.account?.name || status?.account?.email || providers.label : t("studioProviderSwitch")}</small><button className="btn" disabled={Boolean(switching) || (!active && Boolean(status?.busy)) || (!active && !window.onflip.providerSet)} onClick={() => {
        if (active) { onManage(); return; }
        setError(null);
        setSwitching(p.id);
        void window.onflip.providerSet?.(p.id).then((result) => {
          if (!result.ok) {
            setError(result.reason || t("studioProviderFailed"));
            setSwitching(null);
          }
        }).catch((e: Error) => { setError(e.message); setSwitching(null); });
      }}>{switching === p.id ? t("setProviderSwitching") : active ? t("studioManage") : t("studioSwitch")}<StudioIcon name="arrow" size={13} /></button></div>
    </article>;
  })}</div><p className="provider-switch-note"><StudioIcon name="shield" size={17} /><span>{t("setProviderDesc")}</span></p>{error && <div className="msg-error">{error}</div>}</>;
}

export function ConnectionsModal({ status, models, connect, onClose, onManage }: { status: EngineStatus | null; models: ModelDTO[]; connect: ConnectState; onClose: () => void; onManage: () => void }): React.ReactElement {
  const t = useT();
  return <Modal title={t("studioConnections")} onClose={onClose} wide><div className="connections-intro"><p>{t("studioConnectionsDesc")}</p></div><ProviderCards status={status} models={models} connect={connect} onManage={onManage} /></Modal>;
}
