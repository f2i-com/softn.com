/**
 * The SVG charts. No dependency beyond React; about 30 KB minified, which is
 * a sixth of the minimal set and nothing a form or a list ever needs.
 */
export * from '../charts';

import { LineChart } from '../charts/LineChart';
import { BarChart } from '../charts/BarChart';
import { PieChart } from '../charts/PieChart';
import { AreaChart } from '../charts/AreaChart';
import { RadarChart } from '../charts/RadarChart';
import { GaugeChart } from '../charts/GaugeChart';

export const chartComponents = { LineChart, BarChart, PieChart, AreaChart, RadarChart, GaugeChart };
