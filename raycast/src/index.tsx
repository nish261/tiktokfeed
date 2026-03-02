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

const CONFIG_PATH  = path.join(os.homedir(), "config", "tiktok_discord.json");
const PID_FILE     = "/tmp/tiktok_discord.pid";
const LOG_FILE     = "/tmp/tiktok_discord.log";
const START_SCRIPT = path.join(os.homedir(), "tiktok_discord_start.sh");

// ── Types ─────────────────────────────────────────────────────────────────────

interface AccountEntry {
  username: string;
  reposts: boolean;
}

interface Config {
  webhook_url: string;
  accounts: AccountEntry[];
  interval: number;
}

// ── Config I/O ────────────────────────────────────────────────────────────────

function readConfig(): Config {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  // Normalise legacy string array → object array
  parsed.accounts = (parsed.accounts ?? []).map((a: string | AccountEntry) =>
    typeof a === "string"
      ? { username: a.startsWith("@") ? a : "@" + a, reposts: false }
      : a
  );
  return parsed as Config;
}

function writeConfig(cfg: Config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── Daemon ────────────────────────────────────────────────────────────────────

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

// ── Logs ──────────────────────────────────────────────────────────────────────

function recentLogs(n = 15): string[] {
  try {
    return fs
      .readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim() && !l.includes("NotOpenSSL") && !l.includes("urllib3") && !l.includes("Deprecated"))
      .slice(-n)
      .reverse();
  } catch {
    return ["No logs yet"];
  }
}

function formatInterval(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

// ── URL Resolver ──────────────────────────────────────────────────────────────

function isURL(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

function resolveAccountFromURL(url: string): string {
  const script = `
import re, requests
try:
    resp = requests.head(${JSON.stringify(url)}, allow_redirects=True, timeout=15,
        headers={"User-Agent": "Mozilla/5.0"})
    m = re.search(r'/@([^/?&#]+)', resp.url)
    print(m.group(1) if m else "", end="")
except:
    print("", end="")
`.trim();
  try {
    const out = execSync(`python3 -c '${script.replace(/'/g, `'"'"'`)}'`, {
      encoding: "utf-8",
      timeout: 20000,
    });
    return out.trim() ? "@" + out.trim() : "";
  } catch {
    return "";
  }
}

// ── Add Account Form ──────────────────────────────────────────────────────────

function AddAccountForm({ onAdded }: { onAdded: () => void }) {
  const { pop } = useNavigation();
  const [isResolving, setIsResolving] = useState(false);

  async function handleSubmit(values: { account: string; reposts: boolean }) {
    let input = values.account.trim();
    if (!input) return;

    let username = input;

    if (isURL(input)) {
      setIsResolving(true);
      const toast = await showToast({ style: Toast.Style.Animated, title: "Resolving link...", message: input });
      username = resolveAccountFromURL(input);
      setIsResolving(false);

      if (!username) {
        toast.style = Toast.Style.Failure;
        toast.title = "Couldn't find account";
        toast.message = "Make sure the link is a valid TikTok URL";
        return;
      }
      toast.style = Toast.Style.Success;
      toast.title = "Found";
      toast.message = username;
    } else {
      if (!username.startsWith("@")) username = "@" + username;
    }

    try {
      const cfg = readConfig();
      const exists = cfg.accounts.some((a) => a.username.toLowerCase() === username.toLowerCase());
      if (exists) {
        await showToast({ style: Toast.Style.Failure, title: "Already watching", message: username });
        return;
      }
      cfg.accounts.push({ username, reposts: values.reposts });
      writeConfig(cfg);
      const repostNote = values.reposts ? " (+ reposts)" : "";
      await showToast({ style: Toast.Style.Success, title: "Added", message: `${username}${repostNote} — active next cycle` });
      onAdded();
      pop();
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "Failed to update config" });
    }
  }

  return (
    <Form
      navigationTitle="Add Account"
      isLoading={isResolving}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Account" icon={Icon.Plus} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="account"
        title="TikTok Username or Link"
        placeholder="@username  or  https://www.tiktok.com/t/..."
        autoFocus
      />
      <Form.Checkbox
        id="reposts"
        label="Also monitor reposts"
        defaultValue={false}
      />
      <Form.Description text="Paste a share link, video URL, or profile URL — account resolved automatically." />
    </Form>
  );
}

// ── Main Command ──────────────────────────────────────────────────────────────

export default function Command() {
  const { push } = useNavigation();
  const [running, setRunning]     = useState(false);
  const [config, setConfig]       = useState<Config | null>(null);
  const [logs, setLogs]           = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(() => {
    setRunning(isDaemonRunning());
    try { setConfig(readConfig()); } catch { setConfig(null); }
    setLogs(recentLogs());
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleDaemon(action: "start" | "stop" | "restart") {
    const title = action === "stop" ? "Stopping..." : action === "start" ? "Starting..." : "Restarting...";
    const toast = await showToast({ style: Toast.Style.Animated, title });
    const out = runScript(action);
    refresh();
    toast.style = Toast.Style.Success;
    toast.title = out || action;
  }

  async function removeAccount(username: string) {
    const confirmed = await confirmAlert({
      title: "Remove Account",
      message: `Stop watching ${username}?`,
      primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    try {
      const cfg = readConfig();
      cfg.accounts = cfg.accounts.filter((a) => a.username.toLowerCase() !== username.toLowerCase());
      writeConfig(cfg);
      await showToast({ style: Toast.Style.Success, title: "Removed", message: username });
      refresh();
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "Failed to update config" });
    }
  }

  async function toggleReposts(entry: AccountEntry) {
    try {
      const cfg = readConfig();
      const idx = cfg.accounts.findIndex((a) => a.username.toLowerCase() === entry.username.toLowerCase());
      if (idx === -1) return;
      cfg.accounts[idx].reposts = !cfg.accounts[idx].reposts;
      writeConfig(cfg);
      const label = cfg.accounts[idx].reposts ? "Reposts ON" : "Reposts OFF";
      await showToast({ style: Toast.Style.Success, title: label, message: entry.username });
      refresh();
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "Failed to update config" });
    }
  }

  const statusIcon = running
    ? { source: Icon.CircleFilled, tintColor: Color.Green }
    : { source: Icon.CircleFilled, tintColor: Color.Red };
  const accounts = config?.accounts ?? [];
  const interval = config ? formatInterval(config.interval ?? 300) : "—";

  return (
    <List isLoading={isLoading} navigationTitle="TikTok Feed">

      {/* ── Daemon status ── */}
      <List.Section title="Daemon">
        <List.Item
          icon={statusIcon}
          title={running ? "Running" : "Stopped"}
          subtitle={`every ${interval} · ${accounts.length} account${accounts.length !== 1 ? "s" : ""}`}
          actions={
            <ActionPanel>
              {!running && <Action title="Start"   icon={Icon.Play}          onAction={() => handleDaemon("start")} />}
              {running  && <Action title="Stop"    icon={Icon.Stop}          onAction={() => handleDaemon("stop")} />}
              <Action title="Restart" icon={Icon.ArrowClockwise} onAction={() => handleDaemon("restart")} />
              <Action title="Refresh" icon={Icon.RotateClockwise} onAction={refresh} shortcut={{ modifiers: ["cmd"], key: "r" }} />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* ── Accounts ── */}
      <List.Section title={`Watching (${accounts.length})`}>
        {accounts.map((entry) => (
          <List.Item
            key={entry.username}
            icon={Icon.Person}
            title={entry.username}
            accessories={[
              entry.reposts
                ? { icon: { source: Icon.Repeat, tintColor: Color.Blue }, tooltip: "Reposts on" }
                : { icon: { source: Icon.Repeat, tintColor: Color.SecondaryText }, tooltip: "Reposts off" },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={entry.reposts ? "Turn Off Reposts" : "Turn On Reposts"}
                  icon={Icon.Repeat}
                  onAction={() => toggleReposts(entry)}
                />
                <Action
                  title="Add Account"
                  icon={Icon.Plus}
                  onAction={() => push(<AddAccountForm onAdded={refresh} />)}
                />
                <Action
                  title="Remove"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => removeAccount(entry.username)}
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

      {/* ── Recent logs ── */}
      <List.Section title="Recent Activity">
        {logs.map((line, i) => {
          const isPosted = line.includes("Posted");
          const isError  = line.toLowerCase().includes("error") || line.toLowerCase().includes("warn");
          const icon     = isPosted ? { source: Icon.Checkmark, tintColor: Color.Green }
                         : isError  ? { source: Icon.Warning,   tintColor: Color.Yellow }
                         : Icon.Clock;
          const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\w+\s+(.*)/);
          return (
            <List.Item
              key={i}
              icon={icon}
              title={match ? match[2] : line}
              subtitle={match ? match[1].split(" ")[1] : ""}
            />
          );
        })}
      </List.Section>

    </List>
  );
}
