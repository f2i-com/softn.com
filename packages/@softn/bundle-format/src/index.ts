/**
 * The .softn bundle contract, in one dependency-free place.
 *
 * Four things every SoftN surface has to agree on, whether or not it carries
 * the engine: how an archive is read (`zip`), what a bundle declares and
 * whether it is fit to publish or open (`inspect`), what `permission.json`
 * may ask for (`capabilities`), and how one page hands a bundle to another
 * through IndexedDB (`handoff`). The site used to keep hand-copied forks of
 * these because it must not depend on @softn/core (the engine is 1 MB it has
 * no use for); the copies drifted. Now core re-exports these modules under
 * its old paths, so nothing that imported them from core changes, and the
 * site imports them from here.
 *
 * Nothing in here decides what a bundle MEANS at run time; that stays in
 * core. A change here is a change to the contract and must keep every
 * existing .softn file opening exactly as before.
 */
export * from './zip';
export * from './inspect';
export * from './handoff';
export * from './capabilities';
