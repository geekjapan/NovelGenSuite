# 1. エージェント・パイプラインとワークフロー

## 基本原理

システムの基本単位は「1つの物語プロンプトを、順序付きエージェント群の状態機械で、読める原稿と補助資料へ変換する」こと。成果物は自由文ではなく、型付きの Story Bible(企画・人物・世界・プロット・章構成)、章本文、編集レポート、連続性レポート、出版パッケージとして蓄積される。

## 9エージェントの固定順序

1つの定義配列がエージェントの実行順・表示順・リセット開始点のすべてを兼ねる。順序を1箇所で固定することが再現性の要。

| # | エージェント | 役割 | 出力の核 |
|---|---|---|---|
| 1 | Premise Architect (concept) | プロンプトを企画に蒸留 | logline / coreTheme / centralConflict / emotionalPromise / uniqueHook |
| 2 | Character Director (character) | 人物設計 | protagonist / antagonist / supporting(上限あり)。各人物に desire / fear / flaw / secret / arc / speechStyle |
| 3 | World Builder (worldbuilding) | 世界設定 | setting / rules / socialContext / atmosphere / locations / symbols |
| 4 | Plot Strategist (plot) | プロット構造化 | beginning / middle / climax / ending / twists / foreshadowingPlan(伏線計画) |
| 5 | Chapter Architect (chapter-outline) | 章構成の設計 | parts / chapters / styleGuide / foreshadowingTracker |
| 6 | Prose Writer (drafting) | 本文執筆 | 章ごとの draft / chapterSummary / continuityNotes |
| 7 | Style Editor (editor) | 文体・構成批評 | strengths / weakPoints / pacing / dialogue / emotionalClarity / revisionSuggestions |
| 8 | Continuity Detective (continuity) | 連続性監査 | 構造化された issue(category × severity)/ 未回収伏線 / missingPayoffs / 総合診断 |
| 9 | Publisher (publisher) | 出版素材 | titleIdeas / 要約(短・長)/ logline / tagline / SNS文 / 投稿説明 |

設計上のポイント:

- **1〜5(計画段)は直列実行**。各段の成果が次段のコンテキストに累積する。途中で失敗したら該当エージェントを failed にしてループを止める(勝手に飛ばして先へ進まない)。
- **6(執筆)だけは章単位のループ**で、他エージェントと実行モデルが異なる(→ 04章)。
- **7〜9(仕上げ段)は原稿再構築後にまとめて再開**できる独立フェーズ。編集・監査・出版だけの再実行が可能。
- エージェントを追加・変更するときは「ID の型、定義配列、コンテキスト構築、正規化、マージ、フォールバック出力」を必ず同時に更新する。この6点セットが1エージェントの完全な定義。

## 4段階ワークフローと承認ポイント

ユーザーが移動する画面段階は launcher → planning → drafting → final の4つ。エージェント状態(pending/running/completed/failed)とは別軸で管理する。

```
[*] → launcher
launcher → planning        : 生成開始
planning → 承認待ち         : chapter-outline 完了 かつ 承認が必要な設定
承認待ち → drafting         : 構成を承認
planning → drafting        : 承認不要設定ならそのまま
drafting → drafting        : 章を1つずつ生成
drafting → final           : 全章完了後に最終化(editor 以降を実行)
final / drafting → planning : 後戻り(確認を挟む)
```

- **構成承認は human-in-the-loop の中核**。chapter-outline 完了後に意図的に停止し(エラーではない)、ユーザーが章構成を確認・編集してから執筆に進む。承認要否はプロジェクト設定のフラグで制御し、デモ用途ではスキップできる。
- 承認時は**既存の completed / edited 章だけを保持**し、それ以外を pending に戻す。再承認しても完成済みの本文を失わない。
- 進捗表示上、後戻り(現在位置以前への移動)は許すが、未到達ステージへのジャンプは許さない。
- 停止(abort)は第一級の操作。停止された running エージェントは pending に戻し、執筆中なら該当章を「失敗ではなくキャンセル」として記録し、再開候補に残す。

## 再現性の境界

- アプリ側のロジック(段階遷移、承認条件、章候補の選択、長さ判定、マージ規則、エージェント順)は決定的で、テスト可能。
- LLM が書くテキスト内容は非決定的。受け入れ検証は文字列一致ではなく「スキーマ、章数、必須フィールド、状態遷移、閾値、エラー契約」を対象にする。
- JSON parse・正規化・検証・フォールバックは「非決定的なモデル出力を決定的なアプリ状態へ縮約する境界」であり、この境界の設計がシステムの信頼性を決める。
