// Shared wire identities, without publication payload or Adapter dependencies.
export const PublicationTargetProfile = "atape.publication-target.v1"
export const PublicationTargetProfile2 = "atape.publication-target.v2"
export const PublicationTargetProfile3 = "atape.publication-target.v3"
export const PublicationTargetProfile4 = "atape.publication-target.v4"
export const PublicationTargetProfiles34 = `${PublicationTargetProfile3}, ${PublicationTargetProfile4}` as const
