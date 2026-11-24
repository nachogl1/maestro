import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { DialogRow } from "@/components/shared/DialogShell";

const HINT =
  "Maestro's own licence and the licences of the open-source software and the font it ships " +
  "with, in one text file.";

/** Settings row with a plain link that opens the licence and third-party notices file. */
export function LicenceNoticesRow() {
  const [error, setError] = useState<string | null>(null);

  const openNotices = () => {
    setError(null);
    invoke("open_third_party_notices").catch((err) => {
      console.error("Failed to open the third-party notices:", err);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <>
      <DialogRow label="Licences" hint={HINT}>
        <button
          type="button"
          onClick={openNotices}
          className="text-[11px] text-maestro-accent underline hover:opacity-80"
        >
          Licence and third-party notices
        </button>
      </DialogRow>
      {error && (
        <div role="alert" className="text-[11px] text-maestro-red">
          {error}
        </div>
      )}
    </>
  );
}
