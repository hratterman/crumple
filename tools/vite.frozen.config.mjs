// The app's vite config with file watching and HMR off: screenshot tools keep a stable page while
// the worktree is being edited (an edit would otherwise reload the page mid-run).
import base from '../vite.config.ts';

export default {
  ...base,
  server: { ...(base.server ?? {}), hmr: false, watch: { ignored: ['**/*'] } },
};
