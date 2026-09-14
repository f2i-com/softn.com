/**
 * The private editor channel with a same-origin FormLogic parent now lives
 * in @softn/editor-shared. This path stays: FormLogic's
 * `ui/scripts/build-app-editors.mjs` checks for it before building the
 * hosted editors, and it is the module Builder's contract test loads.
 */
export * from '@softn/editor-shared/hostedEditor';
