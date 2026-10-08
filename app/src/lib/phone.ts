/** In-memory hand-off between Settings' phone number screens (phone.tsx -> code.tsx). Never persisted. */
export const phoneFlow: { phone?: string; devCode?: string } = {};
