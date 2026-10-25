/** 构建目录指纹（路径排序 + 内容 sha256）；探针与校验器共用 */
export function hashBuildDir(dir: string): string
