// React bindings for the two external stores.
import { useSyncExternalStore } from "react";
import { controller, type ControllerState } from "./controller";
import { notesStore, type NotesState } from "./store";

export function useNotesState(): NotesState {
  return useSyncExternalStore(notesStore.subscribe, notesStore.get);
}

export function useControllerState(): ControllerState {
  return useSyncExternalStore(controller.subscribe, controller.get);
}
