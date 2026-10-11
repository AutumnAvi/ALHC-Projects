"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { SettingsPanel } from "@/components/settings/settings-panel";
import type { MySettings } from "@/lib/data";
import type { SettingsTab } from "@/lib/shell";
import { loadMySettings } from "@/lib/shell-actions";

// Settings as a modal (Asana's "My settings"), opened from the avatar menu: Profile, Notifications,
// Account, Display. The data is read with the person's own session when it opens.
export function SettingsDialog({ tab: initialTab, onClose }: { tab: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState(initialTab);
  const [data, setData] = useState<MySettings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadMySettings()
      .then((loaded) => {
        if (!live) return;
        if (loaded) setData(loaded);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <Dialog title="Settings" onClose={onClose} width="max-w-2xl" compact>
      {failed ? (
        <p className="text-sm text-red-600">Couldn’t load your settings. Try again.</p>
      ) : (
        <SettingsPanel data={data} tab={tab} onTabChange={setTab} />
      )}
    </Dialog>
  );
}
