import type { Component } from "solid-js";
import PageHeader from "@/components/PageHeader";
import AppearanceSection from "./AppearanceSection";
import BackupSection from "./BackupSection";
import ConflictHistorySection from "./ConflictHistorySection";
import PairingSection from "./PairingSection";
import RecoverySection from "./RecoverySection";
import StorageSection from "./StorageSection";

const SettingsPage: Component = () => {
  return (
    <div class="mx-auto max-w-2xl space-y-4 md:space-y-6">
      <PageHeader
        title="Settings"
        description="Appearance, backup, device pairing, recovery, and storage durability."
      />

      <AppearanceSection />
      <BackupSection />
      <ConflictHistorySection />
      <PairingSection />
      <RecoverySection />
      <StorageSection />
    </div>
  );
};

export default SettingsPage;
