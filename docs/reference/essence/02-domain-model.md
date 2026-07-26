# 2. ドメインモデルと不変条件

## ルート集約: プロジェクト

プロジェクトは1つのルート集約で、以下を同居させる:

- **入力**: ユーザープロンプト、言語、ジャンル、トーン、構成設定(部数・章数・章長)
- **Story Bible**: 全エージェントの計画成果物の正本
- **原稿(manuscript)**: 章構造から再構築される連結本文
- **レポート**: editor / continuity / publisher の3種(null 許容)
- **進行状態**: エージェントごとの状態、章ドラフトごとの状態、ワークフロー段階、承認フラグ

API・シリアライズ境界には JSON 化できる値だけを含め、実行制御(実行中フラグ、AbortController 等)はクライアント専用状態として分離する。

## Story Bible

concept / theme / characters / worldbuilding / plot / parts / chapters / styleGuide / foreshadowingTracker を1つに束ねる。単一値は null 許容、配列は空配列で初期化(null と空配列を混ぜない)。

- **styleGuide**(pov / tense / proseStyle / dialogueNotes / taboos)は plot ではなく章構成(Chapter Architect)の責務。
- **foreshadowingTracker** は伏線のライフサイクルを `planned → unresolved → paid-off` の3状態で追跡する。item / introducedIn / status / suggestedPayoff / payoffChapter / emotionalPurpose を持つ。連続性監査がこれを消費する。

## 章の二重表現と同期

章は「parts(部→章の入れ子)」と「flat chapters(平坦な章配列)」の両方で保持されるミラー構造。**片方だけを直接変更してはならず、必ず同期関数を通す**。

同期の契約:

- 章番号で突き合わせ、**空でない draft を持つ側を優先**する(空レスポンスで既存下書きが消えない)。
- 不足 ID・partNumber を補完する。
- 参照時は parts を正本とし、平坦化して番号順に並べる。

章は number / title / purpose / emotionalTurn / keyEvents / foreshadowing を持ち、任意で lengthPlan(目標長・単位・許容幅)、draft、chapterSummary、continuityNotes、needsRevision を持つ。

## ユーザー入力の保護

AI が構成を再生成しても、**ユーザーが設定した章長計画と、プレースホルダでない章題名は保持する**。マージ時にユーザー値を AI 出力より優先する専用処理を置く。

## 状態の語彙

- エージェント状態: `pending / running / completed / failed` の4値。キャンセルは状態値ではなく操作(abort)として扱い、停止された running エージェントは pending に戻す。
- 章ドラフト状態: `pending / generating / completed / failed / edited`(+長さ判定 `under / near / over / too-short`)。停止された generating 章は pending に戻し、typed cancellation attempt metadata を保存する。`cancelled` 状態や failed への変更、自動再試行は行わない。`edited` は人手編集済みの印で、再生成スキップの根拠になる。**判断: キャンセル表現は原典記録のままにせず、essence をこの語彙へ統一する。**
- エージェント状態と章ドラフト状態と画面段階は**3つの独立した軸**。混ぜない。

## 更新の不変条件

1. **不変更新**: すべての更新関数は新しいオブジェクトを返す。更新のたびに updatedAt を差し替える。
2. **マージは1関数に集約**: エージェント出力の反映は「正規化 → agent ID ごとのマージ → 対象エージェントを completed 化」を1回の呼び出しで行う。agents 配列だけを個別に書き換えない。
3. **章本文の変更は共通経路**: 手編集・改稿・生成のいずれも同じ更新関数を通し、Bible・原稿再構築・プレビュー・実測長・状態を一度に整合させる。
4. **派生値は毎回再計算**: 画面用の派生状態(計画要素一覧、章ドラフト一覧、段階の推定)は保存値を信用せず、Bible から都度導出する(hydration)。古いデータの後方互換もこの導出で吸収する。
5. **patch の意味論**: `null` は明示的な削除、`undefined` は既存値の維持。この区別を全マージで守る。
6. **リセットは下流のみ**: エージェント N からのリセットは N 以降の状態・成果物だけを消し、上流の成果物は保持する。章構成以下をリセットしたら承認フラグも必ず倒す。執筆のリセットは章の draft / 要約 / 連続性メモだけを消し、構成・題名・長さ計画は残す。
7. **再生成は操作を区別する**: draft がある failed / 期待長の75%以上85%未満 / needsExpansion の章は、自動生成の候補にせず、明示的な retry / regenerate でのみ対象にする。「成功レスポンス=十分な本文」と同一視しない。

## 出力正規化(境界での防御)

エージェントの生出力は `unknown` として受け、正規化層で形を確定してから Bible に入れる:

- 文字列は trim + フィールドごとの最大長で切り詰め。
- 配列は要素数上限(例: supporting 2人、locations/symbols 6件、twists 8件、editor 各配列 12件、章 64件)。
- 不正な列挙値は既定値へ丸める(伏線 status → planned、issue category → 既定、severity → medium)。
- レガシー形式(旧フィールド名・文字列配列)は新形式へ変換して受け入れる。ただし新形式に1件でも有効値があれば旧形式は読まない(二重追加防止)。

正規化は「使える形に寄せる best-effort」であり、意味的な品質は保証しない。厳密に reject する検査(strict gate)は、生応答サイズ、JSON parse、章構成の構造検証に限定する。
