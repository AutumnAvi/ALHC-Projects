"use client";

import { useState } from "react";
import { SettingsPanel } from "@/components/settings/settings-panel";
import type { MySettings } from "@/lib/data";
import type { SettingsTab } from "@/lib/shell";

export function SettingsPage({ data, initialTab }: { data: MySettings; initialTab: SettingsTab }) {
  const [tab, setTab] = useState(initialTab);
  return <SettingsPanel data={data} tab={tab} onTabChange={setTab} />;
}
