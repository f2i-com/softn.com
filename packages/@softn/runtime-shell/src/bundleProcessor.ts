/** Bundle processing for hosts of either format. A web-only reader can import
 * bundleFiles directly without linking the classic composer and XDB seed. */
export * from './bundleFiles';
export { loadXDBData, processBundle } from './classicBundle';
