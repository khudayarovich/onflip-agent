import React, { useEffect, useState } from "react";
import type {
  ConfigView,
  EngineStatus,
  ModelDTO,
  RuleAction,
} from "../../../shared/protocol";
import { api } from "../api";
import { Modal, Toggle } from "./common";
import { Lang, LANGS, useT } from "../i18n";
import { Close, RadioOff, RadioOn } from "./icons";

export function SettingsModal({
  status,
  onClose,
  onStatusChange,
  notify,
  theme,
  onSetTheme,
  lang,
  onSetLang,
  notifications,
  onSetNotifications,
}: {
  status: EngineStatus | null;
  onClose: () => void;
  onStatusChange: () => void;
  notify: (text: string) => void;
  theme: "dark" | "light";
  onSetTheme: (theme: "dark" | "light") => void;
  lang: Lang;
  onSetLang: (lang: Lang) => void;
  notifications: boolean;
  onSetNotifications: (on: boolean) => void;
}): React.ReactElement {
  const t = useT();
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [models, setModels] = useState<ModelDTO[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [rulePattern, setRulePattern] = useState("");
  const [ruleAction, setRuleAction] = useState<RuleAction>("allow");

  useEffect(() => {
    void api.getConfig().then(setConfig).catch(() => {});
    void api.listModels().then(setModels).catch(() => {});
  }, []);

  const setValue = (key: string, value: unknown) => {
    void api
      .setConfigValue(key, value)
      .then((next) => {
        setConfig(next);
        onStatusChange();
      })
      .catch((e: Error) => notify(e.message));
  };

  const numberField = (
    key: "maxIterations" | "replyTimeout" | "compactAfterChars",
    name: string,
    desc: string
  ) =>
    config && (
      <div className="setting-row">
        <div className="info">
          <div className="name">{name}</div>
          <div className="desc">{desc}</div>
        </div>
        <input
          type="number"
          defaultValue={config[key]}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 1 && v !== config[key]) setValue(key, v);
          }}
        />
      </div>
    );

  return (
    <Modal title={t("settings")} onClose={onClose} wide>
      <ProviderSection />

      <div className="settings-section">
        <h3>{t("setAppearance")}</h3>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setTheme")}</div>
            <div className="desc">{t("setThemeDesc")}</div>
          </div>
          <div className="segmented">
            <button
              className={theme === "dark" ? "on" : ""}
              onClick={() => onSetTheme("dark")}
            >
              <span className="radio-mark">
                <RadioOn size={13} />
              </span>{" "}
              {t("themeDark")}
            </button>
            <button
              className={theme === "light" ? "on" : ""}
              onClick={() => onSetTheme("light")}
            >
              <span className="radio-mark">
                <RadioOff size={13} />
              </span>{" "}
              {t("themeLight")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setLanguage")}</div>
            <div className="desc">{t("setLanguageDesc")}</div>
          </div>
          <div className="segmented">
            {LANGS.map((entry) => (
              <button
                key={entry.code}
                className={lang === entry.code ? "on" : ""}
                onClick={() => onSetLang(entry.code)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setNotifications")}</div>
            <div className="desc">{t("setNotificationsDesc")}</div>
          </div>
          <Toggle on={notifications} onChange={onSetNotifications} />
        </div>
      </div>

      <div className="settings-section">
        <h3>{t("setAgent")}</h3>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setShellAccess")}</div>
            <div className="desc">{t("setShellAccessDesc")}</div>
          </div>
          <Toggle
            on={status?.shellEnabled ?? true}
            onChange={(on) =>
              void api
                .setShell(on)
                .then(onStatusChange)
                .catch((e: Error) => notify(e.message))
            }
          />
        </div>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setNetwork")}</div>
            <div className="desc">{t("setNetworkDesc")}</div>
          </div>
          <Toggle
            on={status?.networkEnabled ?? true}
            onChange={(on) =>
              void api
                .setNetwork(on)
                .then(onStatusChange)
                .catch((e: Error) => notify(e.message))
            }
          />
        </div>
        {numberField("maxIterations", t("setStepBudget"), t("setStepBudgetDesc"))}
        {numberField("replyTimeout", t("setReplyTimeout"), t("setReplyTimeoutDesc"))}
        {numberField("compactAfterChars", t("setCompactAfter"), t("setCompactAfterDesc"))}
      </div>

      <div className="settings-section">
        <h3>{t("setAutoResume")}</h3>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setAutoResume")}</div>
            <div className="desc">{t("setAutoResumeHelp")}</div>
          </div>
          <Toggle
            on={config?.autoResume ?? true}
            onChange={(on) => setValue("autoResume", on)}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3>{t("setBrowser")}</h3>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setHeaded")}</div>
            <div className="desc">{t("setHeadedDesc")}</div>
          </div>
          <Toggle on={config?.headed ?? false} onChange={(on) => setValue("headed", on)} />
        </div>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setHeadless")}</div>
            <div className="desc">{t("setHeadlessDesc")}</div>
          </div>
          <Toggle
            on={config?.browserHeadless ?? false}
            onChange={(on) => setValue("browserHeadless", on)}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3>{t("setModels")}</h3>
        <div className="setting-row">
          <div className="info">
            <div className="name">{t("setModelsKnown", { n: models.length })}</div>
            <div className="desc">
              {models.some((m) => m.discovered)
                ? t("setModelsFromAccount")
                : t("setModelsBuiltin")}
            </div>
          </div>
          <button
            className="btn"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void api
                .refreshModels()
                .then((next) => {
                  setModels(next);
                  notify(`Model list refreshed — ${next.length} models.`);
                })
                .catch((e: Error) => notify(`Could not refresh models: ${e.message}`))
                .finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? t("refreshing") : t("refreshFromAccountBtn")}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>{t("setRules")}</h3>
        <div className="modal-note">{t("setRulesNote")}</div>
        {config && config.rules.length > 0 && (
          <table className="rules-table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Action</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {config.rules.map((rule) => (
                <tr key={rule.pattern}>
                  <td className="pattern">{rule.pattern}</td>
                  <td>{rule.action}</td>
                  <td>
                    <button
                      className="x"
                      onClick={() => void api.deleteRule(rule.pattern).then(setConfig)}
                    >
                      <Close size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="rule-add">
          <input
            placeholder={'pattern, e.g. "git *"'}
            value={rulePattern}
            onChange={(e) => setRulePattern(e.target.value)}
          />
          <select
            value={ruleAction}
            onChange={(e) => setRuleAction(e.target.value as RuleAction)}
          >
            <option value="allow">allow</option>
            <option value="ask">ask</option>
            <option value="deny">deny</option>
          </select>
          <button
            className="btn"
            disabled={!rulePattern.trim()}
            onClick={() => {
              void api
                .setRule(rulePattern.trim(), ruleAction)
                .then((next) => {
                  setConfig(next);
                  setRulePattern("");
                })
                .catch((e: Error) => notify(e.message));
            }}
          >
            {t("add")}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>{t("setApprovals")}</h3>
        {config && config.allowedCommands.length === 0 && config.allowedWriteDirs.length === 0 && (
          <div className="modal-note">{t("setApprovalsEmpty")}</div>
        )}
        {config && config.allowedCommands.length > 0 && (
          <div className="setting-row">
            <div className="info">
              <div className="name">{t("setCommands")}</div>
              <div className="desc">{config.allowedCommands.join(" · ")}</div>
            </div>
            <button className="btn" onClick={() => setValue("allowedCommands", [])}>
              {t("clear")}
            </button>
          </div>
        )}
        {config && config.allowedWriteDirs.length > 0 && (
          <div className="setting-row">
            <div className="info">
              <div className="name">{t("setWriteDirs")}</div>
              <div className="desc">{config.allowedWriteDirs.join(" · ")}</div>
            </div>
            <button className="btn" onClick={() => setValue("allowedWriteDirs", [])}>
              {t("clear")}
            </button>
          </div>
        )}
      </div>

      <IndicatorSection />

      <TelegramSection />

      <div className="settings-section">
        <h3>{t("setAbout")}</h3>
        <div className="modal-note">
          OnFlip Desktop {status?.version} · transport {status?.transport} · sessions and
          logs live in ~/.onflip
        </div>
      </div>
    </Modal>
  );
}


type TelegramState = {
  enabled: boolean;
  hasToken: boolean;
  allowedIds: string;
  state: "off" | "connecting" | "connected" | "error";
  detail?: string;
  username?: string;
};

/**
 * The Telegram remote.
 *
 * The token is write-only from here: it is stored encrypted by the OS and
 * never sent back, so the field shows whether one is set rather than what it
 * is. Somebody reading over a shoulder — or a screen recording of this
 * dialog — should not walk away with control of the machine.
 */
function TelegramSection(): React.ReactElement {
  const t = useT();
  const [info, setInfo] = useState<TelegramState | null>(null);
  const [token, setToken] = useState("");
  const [ids, setIds] = useState("");
  const [dirty, setDirty] = useState(false);

  const refresh = () => {
    void window.onflip
      .telegramGet?.()
      .then((next) => {
        setInfo(next);
        if (!dirty) setIds(next.allowedIds);
      })
      .catch(() => setInfo(null));
  };
  useEffect(() => {
    refresh();
    return window.onflip.onTelegramChanged?.(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!info) return <></>;

  const save = (patch: { enabled?: boolean; token?: string; allowedIds?: string }) => {
    void window.onflip.telegramSave?.(patch).then((next) => {
      setInfo(next);
      setDirty(false);
      if (patch.token !== undefined) setToken("");
    });
  };

  const dot =
    info.state === "connected"
      ? "ok"
      : info.state === "error"
        ? "bad"
        : info.state === "connecting"
          ? "warm"
          : "off";

  return (
    <div className="settings-section">
      <h3>{t("setTelegram")}</h3>
      <div className="modal-note">{t("setTelegramIntro")}</div>

      <div className="setting-row">
        <div className="info">
          <div className="name">{t("setTelegramEnable")}</div>
          <div className="desc">
            <span className={`tg-dot ${dot}`} />
            {info.state === "connected"
              ? info.username
                ? `@${info.username}`
                : t("setTelegramOn")
              : info.state === "connecting"
                ? t("setTelegramConnecting")
                : info.state === "error"
                  ? (info.detail ?? t("setTelegramError"))
                  : t("setTelegramOff")}
          </div>
        </div>
        <Toggle on={info.enabled} onChange={(on) => save({ enabled: on })} />
      </div>

      <div className="setting-row stack">
        <div className="info">
          <div className="name">{t("setTelegramToken")}</div>
          <div className="desc">
            {info.hasToken ? t("setTelegramTokenSet") : t("setTelegramTokenHelp")}
          </div>
        </div>
        <div className="tg-field">
          <input
            type="password"
            value={token}
            spellCheck={false}
            placeholder={info.hasToken ? "••••••••••••••••" : "123456:ABC-DEF…"}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="btn" disabled={!token.trim()} onClick={() => save({ token: token.trim() })}>
            {t("setTelegramSave")}
          </button>
          {info.hasToken && (
            <button className="btn danger" onClick={() => save({ token: "", enabled: false })}>
              {t("clear")}
            </button>
          )}
        </div>
      </div>

      <div className="setting-row stack">
        <div className="info">
          <div className="name">{t("setTelegramIds")}</div>
          <div className="desc">{t("setTelegramIdsHelp")}</div>
        </div>
        <div className="tg-field">
          <input
            value={ids}
            spellCheck={false}
            placeholder="123456789"
            onChange={(e) => {
              setIds(e.target.value);
              setDirty(true);
            }}
          />
          <button className="btn" disabled={!dirty} onClick={() => save({ allowedIds: ids })}>
            {t("setTelegramSave")}
          </button>
        </div>
      </div>
      {info.enabled && info.hasToken && !ids.trim() && (
        <div className="modal-note tg-warn">{t("setTelegramNoIds")}</div>
      )}
    </div>
  );
}


/**
 * The floating status square.
 *
 * Off by default: an always-on-top window that appears without being asked
 * for is the sort of thing people uninstall an app over.
 */
/**
 * Which chat service OnFlip drives.
 *
 * Switching restarts the app, and the wording says so before the click rather
 * than after: a provider is a different signed-in account, a different browser
 * profile and a different set of chats, and the engine is holding a live
 * conversation on the current one. Restarting is how that is let go of
 * cleanly.
 *
 * It also says the chats are separate, because that is the part people
 * otherwise discover by losing track of a conversation. Nothing moves between
 * providers — a thread lives in the service's own account, and there is
 * nothing to carry across.
 */
function ProviderSection(): React.ReactElement | null {
  const t = useT();
  const [state, setState] = React.useState<{
    id: string;
    label: string;
    all: { id: string; label: string }[];
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void window.onflip.providerGet?.().then(setState).catch(() => setState(null));
  }, []);

  // Older main processes have no such handler; showing nothing is better than
  // showing a control that cannot work.
  if (!state || !window.onflip.providerSet) return null;

  const choose = (id: string) => {
    if (busy || id === state.id) return;
    setBusy(true);
    void window.onflip.providerSet?.(id).catch(() => setBusy(false));
  };

  return (
    <div className="settings-section">
      <h3>{t("setProvider")}</h3>
      <div className="setting-row">
        <div className="info">
          <div className="name">{t("setProviderName")}</div>
          <div className="desc">{t("setProviderDesc")}</div>
        </div>
        <div className="segmented">
          {state.all.map((p) => (
            <button
              key={p.id}
              className={state.id === p.id ? "on" : ""}
              disabled={busy}
              onClick={() => choose(p.id)}
            >
              <span className="radio-mark">
                <RadioOn size={13} />
              </span>{" "}
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {busy && <p className="modal-note">{t("setProviderSwitching")}</p>}
    </div>
  );
}

function IndicatorSection(): React.ReactElement {
  const t = useT();
  const [info, setInfo] = useState<{ enabled: boolean; size: number } | null>(null);

  useEffect(() => {
    void window.onflip
      .indicatorGet?.()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return <></>;
  const save = (patch: { enabled?: boolean; size?: number }) => {
    setInfo((current) => (current ? { ...current, ...patch } : current));
    void window.onflip.indicatorSet?.(patch).then(setInfo);
  };

  return (
    <div className="settings-section">
      <h3>{t("setIndicator")}</h3>
      <div className="modal-note">{t("setIndicatorIntro")}</div>

      <div className="setting-row">
        <div className="info">
          <div className="name">{t("setIndicatorShow")}</div>
          <div className="desc">{t("setIndicatorShowHelp")}</div>
        </div>
        <Toggle on={info.enabled} onChange={(on) => save({ enabled: on })} />
      </div>

      <div className="setting-row">
        <div className="info">
          <div className="name">{t("setIndicatorSize")}</div>
          <div className="desc">{t("setIndicatorSizeHelp", { size: info.size })}</div>
        </div>
        <input
          className="indicator-size"
          type="range"
          min={56}
          max={200}
          step={8}
          value={info.size}
          disabled={!info.enabled}
          onChange={(e) => save({ size: Number(e.target.value) })}
        />
      </div>

      <div className="indicator-legend">
        <span><i className="dot idle" /> {t("setIndicatorIdle")}</span>
        <span><i className="dot working" /> {t("setIndicatorWorking")}</span>
        <span><i className="dot waiting" /> {t("setIndicatorWaiting")}</span>
      </div>
    </div>
  );
}
