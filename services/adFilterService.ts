import Logger from '@/utils/Logger';

const logger = Logger.withTag('AdFilterService');

export class AdFilterService {
  /**
   * 过滤 M3U8 内容中的广告并修正相对路径
   * @param m3u8Content 原始 M3U8 内容
   * @param baseUrl 原始 M3U8 的 URL (用于转换相对路径)
   * @returns 处理后的 M3U8 内容
   */
  public static filterAdsAndRewritePaths(m3u8Content: string, baseUrl: string): string {
    if (!m3u8Content) return '';

    // 广告关键字列表 (与 Web 端保持一致)
    const adKeywords = [
      'sponsor',
      '/ad/',
      '/ads/',
      'advert',
      'advertisement',
      '/adjump',
      'redtraffic'
    ];

    const lines = m3u8Content.split('\n');
    const filteredLines: string[] = [];

    // 获取 base URL 的目录部分，用于相对路径拼接
    // 例如 http://example.com/hls/playlist.m3u8 -> http://example.com/hls/
    const baseUrlDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // 1. 跳过空行
      if (!trimmedLine) {
        i++;
        continue;
      }

      // 2. 处理 #EXT-X-DISCONTINUITY (通常广告前后会有这个标记，激进策略可以去掉，保守策略保留)
      // Web 端逻辑是跳过它
      if (line.includes('#EXT-X-DISCONTINUITY')) {
        i++;
        continue;
      }

      // 3. 处理 #EXTINF 行 (这是分片信息的开始)
      if (line.includes('#EXTINF:')) {
        // 检查下一行 (URI 行)
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const nextLineTrimmed = nextLine.trim();
          
          // 检查 URI 是否包含广告关键字
          const containsAdKeyword = adKeywords.some(keyword =>
            nextLineTrimmed.toLowerCase().includes(keyword.toLowerCase())
          );

          if (containsAdKeyword) {
            logger.debug(`[AdFilter] Removing ad segment: ${nextLineTrimmed}`);
            // 跳过 EXTINF 行和 URI 行
            i += 2;
            continue;
          }

          // 如果不是广告，我们需要处理 URI (转为绝对路径)
          // 先把 EXTINF 行加入结果
          filteredLines.push(line);
          
          // 处理 URI 行
          const absoluteUrl = this.resolveUrl(baseUrlDir, nextLineTrimmed);
          filteredLines.push(absoluteUrl);
          
          i += 2;
          continue;
        }
      }

      // 4. 处理加密 Key (#EXT-X-KEY)
      if (line.startsWith('#EXT-X-KEY:')) {
        // 提取 URI="..." 部分并替换
        const newLine = line.replace(/URI="([^"]+)"/, (match, uri) => {
          const absoluteUrl = this.resolveUrl(baseUrlDir, uri);
          return `URI="${absoluteUrl}"`;
        });
        filteredLines.push(newLine);
        i++;
        continue;
      }

      // 5. 处理 Master Playlist 中的 Stream Inf (#EXT-X-STREAM-INF)
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        filteredLines.push(line);
        // 下一行是子 M3U8 的 URL
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const nextLineTrimmed = nextLine.trim();
          
          // 1. 先转为绝对路径
          const absoluteUrl = this.resolveUrl(baseUrlDir, nextLineTrimmed);
          
          // 2. 再包装成代理地址 (递归调用代理)
          // 格式: http://127.0.0.1:12346/m3u8-proxy?url=ENCODED_URL
          const proxyUrl = `http://127.0.0.1:12346/m3u8-proxy?url=${encodeURIComponent(absoluteUrl)}`;
          
          filteredLines.push(proxyUrl);
          i += 2;
          continue;
        }
      }

      // 6. 处理其他以 # 开头的标签 (直接保留)
      if (line.startsWith('#')) {
        filteredLines.push(line);
        i++;
        continue;
      }

      // 7. 处理纯 URI 行 (如果没有被 EXTINF 捕获到的情况)
      // 这种情况可能是：
      // a) Master Playlist 中的备用流 (无 #EXT-X-STREAM-INF 前缀，但这种情况很少见)
      // b) 错误的格式
      // 我们还是尝试代理它，以防万一
      const absoluteUrl = this.resolveUrl(baseUrlDir, trimmedLine);
      
      // 如果它看起来像是一个 .m3u8 链接，我们也走代理
      if (absoluteUrl.includes('.m3u8')) {
        const proxyUrl = `http://127.0.0.1:12346/m3u8-proxy?url=${encodeURIComponent(absoluteUrl)}`;
        filteredLines.push(proxyUrl);
      } else {
        // 普通分片，直接用绝对路径
        filteredLines.push(absoluteUrl);
      }
      i++;
    }

    return filteredLines.join('\n');
  }

  /**
   * 将相对路径转换为绝对路径
   */
  private static resolveUrl(baseUrl: string, relativeUrl: string): string {
    // 如果已经是绝对路径 (http:// 或 https:// 开头)，直接返回
    if (relativeUrl.match(/^https?:\/\//i)) {
      return relativeUrl;
    }

    // 如果是协议相对路径 (//example.com)，补全协议
    if (relativeUrl.startsWith('//')) {
      const protocol = baseUrl.split(':')[0];
      return `${protocol}:${relativeUrl}`;
    }

    // 如果是根路径 (/path/to/file)，需要加上域名
    if (relativeUrl.startsWith('/')) {
      const urlObj = new URL(baseUrl);
      return `${urlObj.origin}${relativeUrl}`;
    }

    // 普通相对路径，拼接到 baseUrl 后面
    return `${baseUrl}${relativeUrl}`;
  }
}
