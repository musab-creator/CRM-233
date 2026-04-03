"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { Dashboard } from "./Dashboard";
import { Pipeline } from "./Pipeline";
import { ContactList } from "./ContactList";
import { PolicyAnalyzer } from "./PolicyAnalyzer";
import { ContingencyGenerator } from "./ContingencyGenerator";
import { ClaimsTracker } from "./ClaimsTracker";
import { CompanyCamView } from "./CompanyCamView";
import { Marketing } from "./Marketing";
import { JobDetail } from "./JobDetail";
import { StormLookup } from "./StormLookup";
import { Settings } from "./Settings";
import { DocuSignView } from "./DocuSignView";

export function AppShell() {
  const { currentView, selectedJobId, sidebarOpen } = useCRMStore();

  const renderView = () => {
    if (selectedJobId) return <JobDetail />;
    switch (currentView) {
      case "dashboard": return <Dashboard />;
      case "pipeline": return <Pipeline />;
      case "contacts": return <ContactList />;
      case "policy-analyzer": return <PolicyAnalyzer />;
      case "contingency": return <ContingencyGenerator />;
      case "claims": return <ClaimsTracker />;
      case "companycam": return <CompanyCamView />;
      case "marketing": return <Marketing />;
      case "storm-lookup": return <StormLookup />;
      case "docusign": return <DocuSignView />;
      case "settings": return <Settings />;
      default: return <Dashboard />;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{renderView()}</main>
      </div>
    </div>
  );
}
