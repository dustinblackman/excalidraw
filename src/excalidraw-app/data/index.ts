import { canvasToBlob } from "../../data/blob";
import { decompressData } from "../../data/encode";
import {
  decryptData,
  generateEncryptionKey,
  IV_LENGTH_BYTES,
} from "../../data/encryption";
import { serializeAsJSON } from "../../data/json";
import { restore } from "../../data/restore";
import { ImportedDataState } from "../../data/types";
import { isInvisiblySmallElement } from "../../element/sizeHelpers";
import { ExcalidrawElement } from "../../element/types";
import { t } from "../../i18n";
import { exportToCanvas } from "../../scene/export";
import { AppState, BinaryFiles, UserIdleState } from "../../types";
import { bytesToHexString } from "../../utils";
import { DELETED_ELEMENT_TIMEOUT, ROOM_ID_BYTES } from "../app_constants";

export type SyncableExcalidrawElement = ExcalidrawElement & {
  _brand: "SyncableExcalidrawElement";
};

export const isSyncableElement = (
  element: ExcalidrawElement,
): element is SyncableExcalidrawElement => {
  if (element.isDeleted) {
    if (element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT) {
      return true;
    }
    return false;
  }
  return !isInvisiblySmallElement(element);
};

export const getSyncableElements = (elements: readonly ExcalidrawElement[]) =>
  elements.filter((element) =>
    isSyncableElement(element),
  ) as SyncableExcalidrawElement[];

const BACKEND_V2_GET = process.env.REACT_APP_BACKEND_V2_GET_URL;
const BACKEND_V2_POST = process.env.REACT_APP_BACKEND_V2_POST_URL;

const generateRoomId = async () => {
  const buffer = new Uint8Array(ROOM_ID_BYTES);
  window.crypto.getRandomValues(buffer);
  return bytesToHexString(buffer);
};

/**
 * Right now the reason why we resolve connection params (url, polling...)
 * from upstream is to allow changing the params immediately when needed without
 * having to wait for clients to update the SW.
 *
 * If REACT_APP_WS_SERVER_URL env is set, we use that instead (useful for forks)
 */
export const getCollabServer = async (): Promise<{
  url: string;
  polling: boolean;
}> => {
  if (process.env.REACT_APP_WS_SERVER_URL) {
    return {
      url: process.env.REACT_APP_WS_SERVER_URL,
      polling: true,
    };
  }

  try {
    const resp = await fetch(
      `${process.env.REACT_APP_PORTAL_URL}/collab-server`,
    );
    return await resp.json();
  } catch (error) {
    console.error(error);
    throw new Error(t("errors.cannotResolveCollabServer"));
  }
};

export type EncryptedData = {
  data: ArrayBuffer;
  iv: Uint8Array;
};

export type SocketUpdateDataSource = {
  SCENE_INIT: {
    type: "SCENE_INIT";
    payload: {
      elements: readonly ExcalidrawElement[];
    };
  };
  SCENE_UPDATE: {
    type: "SCENE_UPDATE";
    payload: {
      elements: readonly ExcalidrawElement[];
    };
  };
  MOUSE_LOCATION: {
    type: "MOUSE_LOCATION";
    payload: {
      socketId: string;
      pointer: { x: number; y: number };
      button: "down" | "up";
      selectedElementIds: AppState["selectedElementIds"];
      username: string;
    };
  };
  IDLE_STATUS: {
    type: "IDLE_STATUS";
    payload: {
      socketId: string;
      userState: UserIdleState;
      username: string;
    };
  };
};

export type SocketUpdateDataIncoming =
  | SocketUpdateDataSource[keyof SocketUpdateDataSource]
  | {
      type: "INVALID_RESPONSE";
    };

export type SocketUpdateData =
  SocketUpdateDataSource[keyof SocketUpdateDataSource] & {
    _brand: "socketUpdateData";
  };

const RE_COLLAB_LINK = /^#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;

export const isCollaborationLink = (link: string) => {
  const hash = new URL(link).hash;
  return RE_COLLAB_LINK.test(hash);
};

export const getCollaborationLinkData = (link: string) => {
  const hash = new URL(link).hash;
  const match = hash.match(RE_COLLAB_LINK);
  if (match && match[2].length !== 22) {
    window.alert(t("alerts.invalidEncryptionKey"));
    return null;
  }
  return match ? { roomId: match[1], roomKey: match[2] } : null;
};

export const generateCollaborationLinkData = async () => {
  const roomId = await generateRoomId();
  const roomKey = await generateEncryptionKey();

  if (!roomKey) {
    throw new Error("Couldn't generate room key");
  }

  return { roomId, roomKey };
};

export const getCollaborationLink = (data: {
  roomId: string;
  roomKey: string;
}) => {
  return `${window.location.origin}${window.location.pathname}#room=${data.roomId},${data.roomKey}`;
};

/**
 * Decodes shareLink data using the legacy buffer format.
 * @deprecated
 */
const legacy_decodeFromBackend = async ({
  buffer,
  decryptionKey,
}: {
  buffer: ArrayBuffer;
  decryptionKey: string;
}) => {
  let decrypted: ArrayBuffer;

  try {
    // Buffer should contain both the IV (fixed length) and encrypted data
    const iv = buffer.slice(0, IV_LENGTH_BYTES);
    const encrypted = buffer.slice(IV_LENGTH_BYTES, buffer.byteLength);
    decrypted = await decryptData(new Uint8Array(iv), encrypted, decryptionKey);
  } catch (error: any) {
    // Fixed IV (old format, backward compatibility)
    const fixedIv = new Uint8Array(IV_LENGTH_BYTES);
    decrypted = await decryptData(fixedIv, buffer, decryptionKey);
  }

  // We need to convert the decrypted array buffer to a string
  const string = new window.TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  const data: ImportedDataState = JSON.parse(string);

  return {
    elements: data.elements || null,
    appState: data.appState || null,
  };
};

const importFromBackend = async (id: string): Promise<ImportedDataState> => {
  try {
    const response = await fetch(
      `${new URL(window.location.href).origin}/outline/get/${id}`,
    );

    if (!response.ok) {
      window.alert(t("alerts.importBackendFailed"));
      return {};
    }
    const buffer = await response.arrayBuffer();

    try {
      const data: ImportedDataState = JSON.parse(
        new TextDecoder().decode(buffer),
      );

      return {
        elements: data.elements || null,
        appState: data.appState || null, // TODO need to persist.
      };
    } catch (error: any) {
      console.warn(
        "error when decoding shareLink data using the new format:",
        error,
      );
      return legacy_decodeFromBackend({ buffer, decryptionKey: "" });
    }
  } catch (error: any) {
    window.alert(t("alerts.importBackendFailed"));
    console.error(error);
    return {};
  }
};

export const loadScene = async (
  id: string | null,
  // Supply local state even if importing from backend to ensure we restore
  // localStorage user settings which we do not persist on server.
  // Non-optional so we don't forget to pass it even if `undefined`.
  localDataState: ImportedDataState | undefined | null,
) => {
  let data;
  if (id != null) {
    // the private key is used to decrypt the content from the server, take
    // extra care not to leak it
    data = restore(
      await importFromBackend(id),
      localDataState?.appState,
      localDataState?.elements,
      { repairBindings: true },
    );
  } else {
    data = restore(localDataState || null, null, null, {
      repairBindings: true,
    });
  }

  return {
    elements: data.elements,
    appState: data.appState,
    // note: this will always be empty because we're not storing files
    // in the scene database/localStorage, and instead fetch them async
    // from a different database
    files: data.files,
    commitToHistory: false,
  };
};

const blobToBase64 = (blob: any) => {
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  return new Promise((resolve) => {
    reader.onloadend = () => {
      resolve(reader.result);
    };
  });
};

export const exportToBackend = async (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => {
  // @ts-ignore
  const json_id = window.JSON_ID;
  const title = json_id
    ? ""
    : window.prompt("What would you like to call this drawing?");
  const json_export = serializeAsJSON(elements, appState, files, "database");

  try {
    // TODO come back to this.
    // const filesMap = new Map<FileId, BinaryFileData>();
    // for (const element of elements) {
    // if (isInitializedImageElement(element) && files[element.fileId]) {
    // filesMap.set(element.fileId, files[element.fileId]);
    // }
    // }

    // const filesToUpload = await encodeFilesForUpload({
    // files: filesMap,
    // encryptionKey,
    // maxBytes: FILE_UPLOAD_MAX_BYTES,
    // });

    const canvas = await exportToCanvas(
      elements,
      appState,
      {},
      {
        exportBackground: appState.exportBackground,
        viewBackgroundColor: appState.viewBackgroundColor,
        exportPadding: 10,
      },
    );
    const blob = await canvasToBlob(canvas);
    const png_base64 = await blobToBase64(blob);

    const response: any = await fetch(
      `${new URL(window.location.href).origin}/outline/add`,
      {
        method: "POST",
        body: JSON.stringify({
          id: json_id,
          title,
          json: JSON.parse(json_export),
          png: png_base64,
        }),
      },
    );
    const json = await response.json();
    if (json.id) {
      // @ts-ignore
      window.JSON_ID = json.id;
      const url = new URL(window.location.href);
      // We need to store the key (and less importantly the id) as hash instead
      // of queryParam in order to never send it to the server
      url.hash = `json=${json.id}`;
      const urlString = url.toString();

      console.log("URL", urlString);
      window.alert("Saved!");
      // window.prompt(`🔒${t("alerts.uploadedSecurly")}`, urlString);
    } else if (json.error_class === "RequestTooLargeError") {
      window.alert(t("alerts.couldNotCreateShareableLinkTooBig"));
    } else {
      window.alert(t("alerts.couldNotCreateShareableLink"));
    }
  } catch (error: any) {
    console.error(error);
    window.alert(t("alerts.couldNotCreateShareableLink"));
  }
};
