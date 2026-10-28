import { useMutation } from '@tanstack/react-query';
import { describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import type { BotSettings, SettingsUpdate } from '../../../api/types';
import { useInvalidateDashboard } from '../useInvalidateDashboard';

/**
 * One settings write (AI role, gate, model, thinking level…). Each caller supplies its log
 * lines; settings are reloaded afterwards whatever happened, like the original.
 */
export function useSettingsMutation<V>(opts: {
  toBody: (v: V) => SettingsUpdate;
  onOk: (v: V, settings: BotSettings) => void;
  onFail: (v: V, message: string) => void;
}) {
  const invalidate = useInvalidateDashboard();
  return useMutation({
    mutationFn: (v: V) => dashboardApi.saveSettings(opts.toBody(v)),
    onSuccess: (settings, v) => {
      opts.onOk(v, settings);
    },
    onError: (e, v) => {
      opts.onFail(v, describeError(e));
    },
    onSettled: () => {
      invalidate('settings');
    },
  });
}
