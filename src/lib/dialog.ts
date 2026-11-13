import { open } from "@tauri-apps/plugin-dialog";

export async function pickProjectFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Project",
  });
  return selected;
}

/** Opens the folder chooser with its own title, starting in `defaultPath` when given. */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath,
    title,
  });
  return selected;
}
