import type { VoiceTranscriptionProvider } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  listVoiceTranscriptionModels,
  readVoiceTranscriptionEnvironmentStatus,
} from "../../lib/voiceTranscription";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const TRANSCRIPTION_API_KEY_ENV = {
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
} as const;

export function VoiceDictationSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [environmentApiKeys, setEnvironmentApiKeys] = useState({
    openai: false,
    groq: false,
  });
  const [transcriptionModels, setTranscriptionModels] = useState<readonly string[]>([]);
  const [transcriptionModelsLoading, setTranscriptionModelsLoading] = useState(false);
  const [transcriptionModelsError, setTranscriptionModelsError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.voiceTranscriptionEnabled) return;
    let active = true;
    void readVoiceTranscriptionEnvironmentStatus()
      .then((status) => {
        if (active) setEnvironmentApiKeys(status);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [settings.voiceTranscriptionEnabled]);

  const providerLabel = settings.voiceTranscriptionProvider === "openai" ? "OpenAI" : "Groq";
  const apiKeyEnvironmentVariable = TRANSCRIPTION_API_KEY_ENV[settings.voiceTranscriptionProvider];
  const hasEnvironmentApiKey = environmentApiKeys[settings.voiceTranscriptionProvider];
  const hasApiKey = settings.voiceTranscriptionApiKey.trim().length > 0 || hasEnvironmentApiKey;

  useEffect(() => {
    if (!settings.voiceTranscriptionEnabled || !hasApiKey) {
      setTranscriptionModels([]);
      setTranscriptionModelsLoading(false);
      setTranscriptionModelsError(null);
      return;
    }

    let active = true;
    setTranscriptionModelsLoading(true);
    setTranscriptionModelsError(null);
    const timeout = window.setTimeout(
      () => {
        void listVoiceTranscriptionModels({
          provider: settings.voiceTranscriptionProvider,
          apiKey: settings.voiceTranscriptionApiKey,
        })
          .then((models) => {
            if (!active) return;
            setTranscriptionModels(models);
            setTranscriptionModelsLoading(false);
          })
          .catch((cause: unknown) => {
            if (!active) return;
            setTranscriptionModels([]);
            setTranscriptionModelsLoading(false);
            setTranscriptionModelsError(
              cause instanceof Error ? cause.message : "Could not load transcription models.",
            );
          });
      },
      settings.voiceTranscriptionApiKey.trim() ? 400 : 0,
    );

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [
    hasApiKey,
    settings.voiceTranscriptionApiKey,
    settings.voiceTranscriptionEnabled,
    settings.voiceTranscriptionProvider,
  ]);

  useEffect(() => {
    if (
      transcriptionModels.length > 0 &&
      settings.voiceTranscriptionModel &&
      !transcriptionModels.includes(settings.voiceTranscriptionModel)
    ) {
      updateSettings({ voiceTranscriptionModel: "" });
    }
  }, [settings.voiceTranscriptionModel, transcriptionModels, updateSettings]);

  const modelDescription = !hasApiKey
    ? `Add an API key to load models available from ${providerLabel}.`
    : transcriptionModelsLoading
      ? `Loading models available from ${providerLabel}…`
      : transcriptionModelsError
        ? transcriptionModelsError
        : transcriptionModels.length === 0
          ? `${providerLabel} did not return any models.`
          : `Loaded from ${providerLabel} using the configured API key.`;

  return (
    <SettingsSection title="Voice dictation">
      <SettingsRow
        {...searchableSetting("voice-dictation")}
        description="Record from the composer and turn speech into text. Uses portable browser media APIs on Linux, macOS, and Windows."
        control={
          <Switch
            checked={settings.voiceTranscriptionEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ voiceTranscriptionEnabled: Boolean(checked) })
            }
            aria-label="Enable voice dictation"
          />
        }
      />
      {settings.voiceTranscriptionEnabled ? (
        <>
          <SettingsRow
            title="Transcription provider"
            description="Use OpenAI or Groq. T3 loads the models available to the configured API key."
            control={
              <Select
                value={settings.voiceTranscriptionProvider}
                onValueChange={(value) =>
                  updateSettings({
                    voiceTranscriptionProvider: value as VoiceTranscriptionProvider,
                    voiceTranscriptionApiKey: "",
                    voiceTranscriptionModel: "",
                  })
                }
              >
                <SelectTrigger className="w-full sm:w-44" aria-label="Transcription provider">
                  <SelectValue>{providerLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="openai">
                    OpenAI
                  </SelectItem>
                  <SelectItem hideIndicator value="groq">
                    Groq
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title={`${providerLabel} API key`}
            description={
              hasEnvironmentApiKey
                ? `${apiKeyEnvironmentVariable} is configured on the connected T3 server. Enter a key here to override it for this client.`
                : `Stored only in this client's local settings. You can also set ${apiKeyEnvironmentVariable} on the connected T3 server.`
            }
            control={
              <Input
                type="password"
                autoComplete="off"
                className="w-full sm:w-64"
                value={settings.voiceTranscriptionApiKey}
                onChange={(event) =>
                  updateSettings({
                    voiceTranscriptionApiKey: event.target.value,
                    voiceTranscriptionModel: "",
                  })
                }
                placeholder={
                  hasEnvironmentApiKey ? `Using ${apiKeyEnvironmentVariable}` : "Required"
                }
                aria-label={`${providerLabel} transcription API key`}
              />
            }
          />
          <SettingsRow
            title="Transcription model"
            description={modelDescription}
            control={
              <Select
                value={settings.voiceTranscriptionModel}
                disabled={transcriptionModelsLoading || transcriptionModels.length === 0}
                onValueChange={(value) => {
                  if (value !== null) updateSettings({ voiceTranscriptionModel: value });
                }}
              >
                <SelectTrigger className="w-full sm:w-64" aria-label="Transcription model">
                  <SelectValue>
                    {settings.voiceTranscriptionModel ||
                      (transcriptionModelsLoading ? "Loading models…" : "Select model")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {transcriptionModels.map((model) => (
                    <SelectItem hideIndicator key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
