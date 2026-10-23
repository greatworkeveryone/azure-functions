// What a provider hands back to the gateway: the model's text, untrusted, and the
// name of the model that wrote it. A provider fails by throwing AiProviderFailure.

export interface ProviderAnswer {
  model: string;
  text: string;
}
