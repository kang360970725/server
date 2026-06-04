export type MiniApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

export function miniOk<T>(data: T, message = 'ok'): MiniApiResponse<T> {
  return {
    code: 0,
    message,
    data,
  };
}
