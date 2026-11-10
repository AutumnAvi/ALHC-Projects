"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { SettingsPanel, type SettingsData } from "@/components/settings/settings-panel";
import type { SettingsTab } from "@alhc/core/shell";
import { loadSettings } from "@/lib/actions/shell";

// Settings as a modal (Asana's "My settings"): Profile, Notifications, Email forwarding, Account,
// Display, with the tabs across the top. Opened from the avatar menu, the Inbox's Manage notifications,
// and any link with ?settings=<tab> (SettingsFromUrl). The data is read with the person's own session
// when it opens.
export function SettingsDialog({ tab: initialTab, onClose }: { tab: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState(initialTab);
  const [data, setData] = useState<SettingsData | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped by "Try again" (here, or a part of the panel that didn't load).
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setFailed(false);
    setData(null);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    let live = true;
    loadSettings()
      .then((loaded) => {
        if (!live) return;
        if (loaded) setData(loaded);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [attempt]);

  return (
    <Dialog title="Settings" onClose={onClose} width="max-w-3xl" compact>
      {failed ? (
        <p role="alert" className="text-sm text-red-600">
          Couldn’t load your settings.{" "}
          <button type="button" onClick={retry} className="font-medium text-accent-700 hover:underline">
            Try again
          </button>
        </p>
      ) : (
        <SettingsPanel data={data} tab={tab} onTabChange={setTab} onRetry={retry} />
      )}
    </Dialog>
  );
}
