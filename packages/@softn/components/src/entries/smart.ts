/**
 * The Smart family: the data-bound grid, view, form, stats, cards, list and
 * timeline. About 60 KB minified, the largest group after Scene3D, and
 * bound to the app's store through the app scope rather than to anything a
 * static first screen renders.
 */
export * from '../smart';

import { SmartGrid } from '../smart/SmartGrid';
import { SmartView } from '../smart/SmartView';
import { SmartForm } from '../smart/SmartForm';
import { SmartStats } from '../smart/SmartStats';
import { SmartCards } from '../smart/SmartCards';
import { SmartList } from '../smart/SmartList';
import { SmartTimeline } from '../smart/SmartTimeline';

export const smartComponents = {
  SmartGrid,
  SmartView,
  SmartForm,
  SmartStats,
  SmartCards,
  SmartList,
  SmartTimeline,
};
