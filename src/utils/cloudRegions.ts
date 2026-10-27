import regionMapping from '../../cloud-regions.json';

export type CloudRegionId = 'global' | 'china';
export type CloudEnvironment = keyof typeof regionMapping;

export interface CloudRegion {
  id: CloudRegionId;
  apiUrl: string;
  appUrl: string;
}

/** Official defaults shared by device binding and cloud region navigation. */
export function getCloudRegions(environment: CloudEnvironment): CloudRegion[] {
  return (['global', 'china'] as const).map(id => ({
    id,
    ...regionMapping[environment][id],
  }));
}
