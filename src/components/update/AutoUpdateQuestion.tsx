import { ArrowDownCircle } from "lucide-react";
import { DialogShell, dialogButtonClass } from "@/components/shared/DialogShell";
import { useUpdateStore } from "@/stores/useUpdateStore";

/** The one-time question about installing updates when Maestro opens. */
export const AUTO_UPDATE_QUESTION =
  "Install Maestro updates automatically when you open it? Maestro restarts once to finish. " +
  "You can change this in Maestro Settings.";

/**
 * Asks once, after the update settings are loaded, whether an update found
 * when Maestro opens should install on its own. Either answer (closing the
 * dialog counts as Not now) is saved, so it never shows again.
 */
export function AutoUpdateQuestion() {
  const settingsLoaded = useUpdateStore((s) => s.settingsLoaded);
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
