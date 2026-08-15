import type { Component } from "solid-js";
import PageHeader from "@/components/PageHeader";
import AppearanceSection from "./AppearanceSection";
import ConflictHistorySection from "./ConflictHistorySection";
import DevicesSection from "./DevicesSection";
import PairingSection from "./PairingSection";
import RecoverySection from "./RecoverySection";
import StorageSection from "./StorageSection";

const SettingsPage: Component = () => {
  return (
    <div class="mx-auto max-w-2xl space-y-4 md:space-y-6">
      <PageHeader
        title="Settings"
        description="Appearance, device pairing, recovery, and storage durability."
      />

      <AppearanceSection />
      <ConflictHistorySection />
      <PairingSection />
      <DevicesSection />
      <RecoverySection />
      <StorageSection />
    </div>
  );
};

export default SettingsPage;
