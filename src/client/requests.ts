import axios, {type AxiosRequestConfig} from 'axios';
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {ImageMetadataTarget} from "@/types";

const axiosPost = (
  url: any,
  bodyDict: any,
  config: AxiosRequestConfig = {},
) => {
  return axios.post(url, bodyDict, config);
};

const axiosGet = (
  url: any,
  config: AxiosRequestConfig = {},
) => {
  return axios.get(url, config);
};

const deleteImage = (
  imageUrl: string,
  target?: ImageMetadataTarget,
) => axios.delete(ADMIN_URLS.ajaxR2Ops(), {
  data: {imageUrl, target},
});

function uploadFile(file: any, cdnFilename: any, onProgress: any, onUploaded: any, onFailure: any, onR2OpsFailure: any) {
  const { size, type } = file;
  axiosPost(ADMIN_URLS.ajaxR2Ops(), {
    size,
    key: cdnFilename,
    type,
  }).then((res: any) => {
    const fileReader = new FileReader();
    fileReader.onloadend = (e: any) => {
      const arrayBuffer = e.target.result;
      if (arrayBuffer) {
        const {mediaBaseUrl, presignedUrl} = res.data;
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", presignedUrl, true);
        xhr.upload.addEventListener("progress", (event: any) => {
          if (event.lengthComputable) {
            onProgress(event.loaded / event.total);
            // this.setState({progressText: `${parseFloat(event.loaded / event.total * 100.0).toFixed(2)}%`});
          }
        });
        xhr.addEventListener("load", () => {
          const mediaUrl = `${mediaBaseUrl}/${cdnFilename}`;
          if (xhr.status >= 200 && xhr.status < 300) {
            // R2 单段 PUT 返回的 ETag **就是内容的 MD5**（S3 语义，本地实测一致：
            // etag == md5）。把它一并交给调用方，需要 md5 的场景（如「版本管理」页
            // 上传 APK）就不必再对 20MB 算一遍哈希。`httpEtag` 带引号，这里去掉。
            let etag: string | null = null;
            try {
              const raw = JSON.parse(xhr.responseText)?.etag;
              const unquoted = String(raw ?? "").replace(/^"|"$/g, "");
              etag = unquoted || null;
            } catch {
              // 非 JSON 响应（代理/旧后端）：etag 留空，由调用方决定是否自己算。
            }
            onUploaded(mediaUrl, arrayBuffer, etag);
          } else if (onFailure) {
            onFailure({
              response: {
                data: xhr.responseText,
                status: xhr.status,
              },
            });
          }
        });
        xhr.addEventListener("error", (event: any) => {
          if (onFailure) {
            onFailure(event);
          }
        });
        xhr.send(arrayBuffer);
      }
    };
    fileReader.readAsArrayBuffer(file);
  }).catch((error: any) => {
    onR2OpsFailure(error);
  });
}

const Requests = {
  axiosPost,
  axiosGet,
  deleteImage,
  upload: uploadFile,
};

export default Requests;
