/**
 * DS娘 v0.4 · 本地小情绪模型（emotion-small.js）的类型声明
 *
 * 为什么单独写 .d.ts：tsconfig 没开 allowJs，工程也不希望把 832KB 的权重文件纳入
 * 类型检查/编译范围，所以只给它的对外接口写声明，实现仍由 Vite 在运行时按需加载。
 */

export interface SmallEmotionPrediction {
  label: string;
  prob?: number;
  top?: Array<{ label: string; prob: number }>;
}

export interface SmallEmotionModel {
  predict(text: string): SmallEmotionPrediction;
}

export declare function createEmotionModel(): SmallEmotionModel;
