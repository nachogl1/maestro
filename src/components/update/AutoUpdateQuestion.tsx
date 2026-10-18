import { ArrowDownCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { DialogShell, dialogButtonClass } from "@/components/shared/DialogShell";
import { settingsHydrated, useUpdateStore } from "@/stores/useUpdateStore";

/** The one-time question about installing updates when Maestro opens. */
export const AUTO_UPDATE_QUESTION =
  "Install Maestro updates automatically when you open it? Maestro restarts once to finish. " +
  "You can change this in Settings → Updates.";

/** Whether the persisted update settings have been read back from disk. */
function useSettingsLoaded(): boolean {
  const [loaded, setLoaded] = useState(() => useUpdateStore.persist.hasHydrated());
  useEffect(() => {
    if (loaded) return;
    let active = true;
    void settingsHydrated().then(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, [loaded]);
  return loaded;
}

/**
 * Asks once, after the update settings are loaded, whether an update found
 * when Maestro opens should install on its own. Either answer (closing the
 * dialog counts as Not now) is saved, so it never shows again.
 */
export function AutoUpdateQuestion() {
  const settingsLoaded = useSettingsLoaded();
  const autoInstallOnLaunch = useUpdateStore((s) => s.autoInstallOnLaunch);
  const setAutoInstallOnLaunch = useUpdateStore((s) => s.setAutoInstallOnLaunch);

  if (!settingsLoaded || autoInstallOnLaunch !== null) return null;

  const decline = () => setAutoInstallOnLaunch(false);

  return (
    <DialogShell
      title="Automatic updates"
      icon={<ArrowDownCircle size={16} />}
      onClose={decline}
      size="sm"
      closeOnOutsideClick={false}
      footer={
        <>
          <button type="button" onClick={decline} className={dialogButtonClass("ghost")}>
            Not now
          </button>
          <button
            type="button"
            onClick={() => setAutoInstallOnLaunch(true)}
            className={dialogButtonClass("primary")}
          >
            Turn on
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-maestro-text">{AUTO_UPDATE_QUESTION}</p>
    </DialogShell>
  );
}
