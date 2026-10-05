import * as path from "node:path";

/**
 * A window icon and a process AppUserModelID do not name the taskbar's
 * relaunch entry. Give Explorer the whole identity, including both relaunch
 * fields (Windows ignores either one alone). A dev relaunch must carry the
 * checkout path or it opens Electron's welcome screen instead of OnFlip.
 */
export function windowAppDetails(
  executable: string,
  appPath: string,
  packaged: boolean
): import("electron").AppDetailsOptions {
  return {
    appId: "com.onflip.desktop",
    appIconPath: path.join(appPath, "buildResources", "icon.ico"),
    appIconIndex: 0,
    relaunchCommand: packaged ? `"${executable}"` : `"${executable}" "${appPath}"`,
    relaunchDisplayName: "OnFlip",
  };
}
