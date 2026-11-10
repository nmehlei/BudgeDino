/**
 * Hand-over between the register and TOTP screens. Memory only: the provisioning URI holds the
 * TOTP secret, so it never goes into route params, MMKV or the query cache.
 */
interface Pending {
  pendingId: string;
  totpProvisioningUri: string;
}

let pending: Pending | null = null;

export const pendingRegistration = {
  set(value: Pending) {
    pending = value;
  },
  get: (): Pending | null => pending,
  clear() {
    pending = null;
  },
};
