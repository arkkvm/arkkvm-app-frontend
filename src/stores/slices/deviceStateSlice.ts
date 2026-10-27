import type { StateCreator } from 'zustand';
import type { RootState } from '../types';
import type { ControlOwner } from '@/api/rpc/control';

export type HdmiStates =
  | 'ready'
  | 'no_signal'
  | 'no_lock'
  | 'out_of_range'
  | 'connecting'
  | 'hdmi_disconnected'

export type HdmiErrorStates = Extract<
  HdmiStates,
  'no_signal' | 'no_lock' | 'out_of_range' | 'hdmi_disconnected'
>

export interface ATXState {
  power: boolean
  hdd: boolean
}

export interface DeviceState {
  agentControlOwner: ControlOwner | undefined
  agentViewOnly: boolean
  setAgentControlOwner: (owner: ControlOwner | undefined, reason?: string) => void
  // Raw video resolution.
  videoWidth: number
  videoHeight: number
  setVideoResolution: (width: number, height: number) => void

  // Container size (video element client area).
  containerWidth: number
  containerHeight: number
  setContainerSize: (width: number, height: number) => void

  // HDMI connection state.
  hdmiConnectionState: HdmiStates
  setHdmiConnectionState: (state: HdmiStates) => void

  // ATX power state (device-related).
  atxState: ATXState
  setAtxState: (state: ATXState) => void
}

export const createDeviceStateSlice: StateCreator<RootState, [], [], DeviceState> = (set) => ({
  agentControlOwner: undefined,
  agentViewOnly: false,
  setAgentControlOwner: (owner, reason) => set(state => ({
    agentControlOwner: owner,
    agentViewOnly: owner === 'user' && (reason === 'takeOver' ||
      (reason === undefined && state.agentControlOwner === owner && state.agentViewOnly)),
  })),
  videoWidth: 0,
  videoHeight: 0,
  setVideoResolution: (width: number, height: number) => {
    set({ videoWidth: width, videoHeight: height });
  },
  containerWidth: 0,
  containerHeight: 0,
  setContainerSize: (width: number, height: number) => {
    set({ containerWidth: width, containerHeight: height });
  },
  // Initial state: connecting.
  hdmiConnectionState: 'connecting' as HdmiStates,
  setHdmiConnectionState: (state: HdmiStates) => {
    if (!state) return;
    const { ready, error } = state;

    if (ready) {
      return set({ hdmiConnectionState: 'ready' });
    } else if (error) {
      return set({ hdmiConnectionState: error });
    } else {
      return set({ hdmiConnectionState: 'connecting' });
    }
  },
  // ATX power state.
  atxState: {
    power: false,
    hdd: false,
  } as ATXState,
  setAtxState: (state: ATXState) => {
    set({ atxState: state });
  },
});
