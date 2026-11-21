import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SecretInput } from "./SecretInput";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function ApprovalExplanationSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { scope, environment } = useSettingsScope();
  const environmentId = scope.kind === "environment" ? environment?.environmentId : null;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["approvalExplanationApiKey"]}
      {...searchableSetting("approval-explanation-api-key")}
      description={gt(
        "Explains approval commands with Gemini 3.1 Flash Lite through Wonton. The API key is stored encrypted on the selected environment.",
      )}
      control={
        environmentId ? (
          <ApprovalExplanationKeyForm key={environmentId} environmentId={environmentId} />
        ) : (
          <span className="text-sm text-muted-foreground">
            {scope.kind === "environment"
              ? gt("Reconnect this environment to configure its key.")
              : gt("Select one environment above to configure its key.")}
          </span>
        )
      }
    />
  );
}

function ApprovalExplanationKeyForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const configured = useEnvironmentSettings(
    environmentId,
    (settings) => settings.approvalExplanationApiKey.length > 0,
  );
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "failed">("idle");
  const saving = saveState === "saving";

  async function save(key: string) {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope) || saving) return;
    setSaveState("saving");
    const result = await updateSettings({
      environmentId,
      input: { patch: { approvalExplanationApiKey: key } },
    });
    if (result._tag === "Success") {
      setDraft("");
      setSaveState("idle");
    } else {
      setSaveState("failed");
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <SecretInput
        size="sm"
        aria-label={gt("Approval explanation API key")}
        configured={configured}
        value={draft}
        disabled={!canConfigure || saving}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaveState("idle");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (draft.trim()) void save(draft.trim());
          }
        }}
      />
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground" role="status">
          {saving ? gt("Saving…") : configured ? gt("Key saved") : gt("No key saved")}
        </span>
        {configured ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canConfigure || saving}
            onClick={() => void save("")}
          >
            {gt("Clear key")}
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={!canConfigure || saving || !draft.trim()}
          onClick={() => void save(draft.trim())}
        >
          {configured ? gt("Replace key") : gt("Save key")}
        </Button>
      </div>
      {saveState === "failed" ? (
        <span role="alert" className="text-xs text-destructive">
          {gt("Key not saved. Your entry is kept. Try again.")}
        </span>
      ) : !canConfigure ? (
        <span className="text-xs text-muted-foreground">
          {gt("This connection cannot change settings.")}
        </span>
      ) : null}
    </div>
  );
}
