import {
  List,
  ActionPanel,
  Action,
  Icon,
  Form,
  useNavigation,
  showToast,
  Toast,
  confirmAlert,
  Alert,
  Color,
} from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CONFIG_PATH = path.join(os.homedir(), "config", "tiktok_discord.json");
const PID_FILE = "/tmp/tiktok_discord.pid";
const LOG_FILE = "/tmp/tiktok_discord.log";
const START_SCRIPT = path.join(os.homedir(), "tiktok_discord_start.sh");

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Config {
  webhook_url: string;
  accounts: string[];
  interval: number;
}

function readConfig(): Config {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

function writeConfig(cfg: Config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function isDaemonRunning(): boolean {
  try {
    if (!fs.existsSync(PID_FILE)) return false;
    const pid = fs.readFileSync(PID_FILE, "utf-8").trim();
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runScript(action: string): string {
  try {
    return execSync(`bash "${START_SCRIPT}" ${action}`, { encoding: "utf-8" }).trim();
  } catch (e: unknown) {
    return (e as Error).message;
  }
}

function recentLogs(n = 15): string[] {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    return content
      .split("\n")
      .filter(
        (l) => l.trim() && !l.includes("NotOpenSSL") && !l.includes("urllib3") && !l.includes("Deprecated")
      )
      .slice(-n)
      .reverse();
  } catch {
    return ["No logs yet"];
  }
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

// ── Add Account Form ──────────────────────────────────────────────────────────

function AddAccountForm({ onAdded }: { onAdded: () => void }) {
  const { pop } = useNavigation();

  async function handleSubmit(values: { account: string }) {
    let account = values.account.trim();
    if (!account) return;
    if (!account.startsWith("@")) account = "@" + account;

    try {
      const cfg = readConfig();
      if (cfg.accounts.map((a) => a.toLowerCase()).includes(account.toLowerCase())) {
        await showToast({ style: Toast.Style.Failure, title: "Already watching", message: account });
        return;
      }
      cfg.accounts.push(account);
      writeConfig(cfg);
      await showToast({ style: Toast.Style.Success, title: "Added", message: `${account} — active next cycle` });
      onAdded();
      pop();
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "Failed to update config" });
    }
  }

  return (
    <Form
      navigationTitle="Add Account"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Account" icon={Icon.Plus} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="account" title="TikTok Username" placeholder="@username" autoFocus />
    </Form>
  );
}

// ── Main Command ──────────────────────────────────────────────────────────────

export default function Command() {
  const { push } = useNavigation();
  const [running, setRunning]   = useState(false);
  const [config, setConfig]     = useState<Config | null>(null);
  const [logs, setLogs]         = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(() => {
    setRunning(isDaemonRunning());
    try {
      setConfig(readConfig());
    } catch {
      setConfig(null);
    }
    setLogs(recentLogs());
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleDaemon(action: "start" | "stop" | "restart") {
    const toast = await showToast({ style: Toast.Style.Animated, title: action === "stop" ? "Stopping..." : action === "start" ? "Starting..." : "Restarting..." });
    const out = runScript(action);
    refresh();
    toast.style = Toast.Style.Success;
    toast.title = out || action;
  }

  async function removeAccount(account: string) {
    const confirmed = await confirmAlert({
      title: "Remove Account",
      message: `Stop watching ${account}?`,
      primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    try {
      const cfg = readConfig();
      cfg.accounts = cfg.accounts.filter((a) => a.toLowerCase() !== account.toLowerCase());
      writeConfig(cfg);
      await showToast({ style: Toast.Style.Success, title: "Removed", message: account });
      refresh();
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "Failed to update config" });
    }
  }

  const statusIcon  = running ? { source: Icon.CircleFilled, tintColor: Color.Green } : { source: Icon.CircleFilled, tintColor: Color.Red };
  const statusText  = running ? "Running" : "Stopped";
  const accounts    = config?.accounts ?? [];
  const interval    = config ? formatInterval(config.interval ?? 300) : "—";

  return (
    <List isLoading={isLoading} navigationTitle="TikTok Feed">

      {/* ── Status ── */}
      <List.Section title="Daemon">
        <List.Item
          icon={statusIcon}
          title={statusText}
          subtitle={`polling every ${interval} · ${accounts.length} account${accounts.length !== 1 ? "s" : ""}`}
          actions={
            <ActionPanel>
              {!running && <Action title="Start" icon={Icon.Play} onAction={() => handleDaemon("start")} />}
              {running  && <Action title="Stop"  icon={Icon.Stop} onAction={() => handleDaemon("stop")} />}
              <Action title="Restart" icon={Icon.ArrowClockwise} onAction={() => handleDaemon("restart")} />
              <Action title="Refresh" icon={Icon.RotateClockwise} onAction={refresh} shortcut={{ modifiers: ["cmd"], key: "r" }} />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* ── Accounts ── */}
      <List.Section title={`Watching (${accounts.length})`}>
        {accounts.map((account) => (
          <List.Item
            key={account}
            icon={Icon.Person}
            title={account}
            actions={
              <ActionPanel>
                <Action
                  title="Remove"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => removeAccount(account)}
                />
                <Action
                  title="Add Account"
                  icon={Icon.Plus}
                  onAction={() => push(<AddAccountForm onAdded={refresh} />)}
                />
                <Action title="Refresh" icon={Icon.RotateClockwise} onAction={refresh} shortcut={{ modifiers: ["cmd"], key: "r" }} />
              </ActionPanel>
            }
          />
        ))}
        <List.Item
          icon={{ source: Icon.Plus, tintColor: Color.Blue }}
          title="Add Account"
          actions={
            <ActionPanel>
              <Action title="Add Account" icon={Icon.Plus} onAction={() => push(<AddAccountForm onAdded={refresh} />)} />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* ── Logs ── */}
      <List.Section title="Recent Activity">
        {logs.map((line, i) => {
          const isPosted = line.includes("Posted");
          const isError  = line.toLowerCase().includes("error") || line.toLowerCase().includes("warn");
          const icon     = isPosted ? { source: Icon.Checkmark, tintColor: Color.Green }
                         : isError  ? { source: Icon.Warning,   tintColor: Color.Yellow }
                         : Icon.Clock;
          // Strip timestamp prefix for title, keep it in subtitle
          const match   = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\w+\s+(.*)/);
          const title   = match ? match[2] : line;
          const time    = match ? match[1].split(" ")[1] : "";
          return (
            <List.Item
              key={i}
              icon={icon}
              title={title}
              subtitle={time}
            />
          );
        })}
      </List.Section>

    </List>
  );
}
