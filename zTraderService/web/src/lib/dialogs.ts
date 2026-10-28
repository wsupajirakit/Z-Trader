/**
 * Native confirm / prompt / alert, behind one seam so they can be stubbed in tests and swapped
 * for in-app dialogs later without touching the features that call them.
 */
export const dialogs = {
  confirm: (message: string): boolean => window.confirm(message),
  prompt: (message: string, defaultValue = ''): string | null =>
    window.prompt(message, defaultValue),
  alert: (message: string): void => {
    window.alert(message);
  },
};
