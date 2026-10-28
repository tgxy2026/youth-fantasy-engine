#!/usr/bin/env bash
# 全量单测 · 分批跑（2026-10-06 立）
#
# 🔴 为什么不用 npm test / run-all.mjs：
#    它内部用 `spawnSync`，而本机对 spawnSync / execFileSync 恒返回 EBUSY ——
#    子进程压根没起来、status 是 null，实测 159 个入口会「全红」。
#    那是环境问题，不是真挂。**外层 bash 循环逐个调 build-test.mjs 才准。**
#
# 用法：
#   bash tests/run-batches.sh A          # 只跑 A 批
#   bash tests/run-batches.sh A B        # 跑 A、B 批
#   bash tests/run-batches.sh all        # 四批全跑（等价于全量）
#   bash tests/run-batches.sh            # 缺省 = all
#   Windows / Codex 沙箱可用 PowerShell 入口：tests/run-batches.ps1 [A|B|C|D|all]
#
# 分批依据（当前数量和耗时会变，运行时以脚本汇总为准）：
#   A 结构闸 / 守卫    纯静态扫描，改完最该先看它绿不绿
#   B 纯函数 / 解析    无 IO，用于快速反馈
#   C 业务逻辑         AI 任务 / 章节 / 设定 / 偏好，多数纯逻辑
#   D 重 IO            酒馆 store / 备份同步 / IDB / demo 项目 / 大计算
#
# ⚠️ 批次划分是「按经验分组」，不是「按实测耗时精确排序」——
#    A 批里 syncGuards 单独就占 8s。若要精调，先跑一次带计时再挪。
# 新加测试文件必须归进某一批；下方清单核对会在漏项或残项时失败关闭。
set -u

cd "$(dirname "$0")/.." || exit 1

# 托管 node（与项目其余实机/构建脚本同源；旧版本号 22.22.2-3 已删除）
NODE="${NODE_BIN:-C:/Users/18223/.workbuddy/binaries/node/versions/22.22.2-6/node.exe}"
if [ ! -f "$NODE" ]; then
  echo "❌ 找不到 node：$NODE" >&2
  echo "   可用 NODE_BIN=/path/to/node.exe bash tests/run-batches.sh 覆盖" >&2
  exit 1
fi

BATCH_A="structureGates appIcon tableSheetPan masterDetailScroll collapseHeaderAlign geoMapLabel writingCalendar visualEmptyStates imageGuards tableSheetRowActions tavernRunEmptyState visualToolbarA2G rowWindow importCycles sensitiveMeta uiUxGuards syncGuards privateCloudSync promptGuard chapterScopeGuard platformCheck antiSpoiler aiDataSources aiFillSemantics paramGuide customOptions themeContrast tavernTimeout tavernWindow depOverrides updateDownload sourceClaims sourcePathGuard kbInline outlineDraftSwitch"

BATCH_B="indexedFieldWriter asyncRecordOwner tableRecordDraftCommit manualDraftSave recordStorageOwner candidateSubmission storageWriteStatus storageFailureNotice workspaceScrollMath navigationDestinationRead recordDraftFlush referenceIntent navigationGate workspaceIdentity workspaceViewState characterProfile failureSummary density auditContractsEvidence auditFunctionScope docRefsTool tablePerformance cloudConditionalWrite portableConditionalWrite importVersionGate saveProbeBarrier saveFailureHint guestImportShape profileRoundtrip webCloudEvidence desktopEvidence webGuestEvidence processBoundary testPlan reliabilityEvidence proofreadProtocol candidateCrash portableSaveFailure portableWriteFailure probeEvidenceGuards sidecarMigration platformMatrix releaseArtifacts atlasCustomOptions dataFileReject aiParse aiParseDetailed inlineSuggest indent exportIndent schemaTemplates customTheme fieldAlias extractAliases extractFields textDiff storyStructures structurePace graphVisual timelineScale volumeGap chapterSeq autoCode relationMulti settingSearchAlias mentions legacyMigration contextLayers evidenceGate aiRefusal aiUsageStats futureImpact themeZoom bookVersion tavernProfileFit styleFit sidecar viewSelectors runKp runClues runEndings chapterImport dropdownPos chapterBoardView monoMarks aiHeaders atlasFields backupShards contextAssembler tableDigest cardMove atlasDetailEdit atlasOrder punctPair imageDrop recheckMemo worldVersionDiff planCompareAi planCompareRun reviewCoverage migrationLock templateGuards leaveBarrier navigationHistory editorViewMath fieldSaveOutcome taskLifecycle imeGuards chapterReorder moduleLoad"

BATCH_C="candidateRunner candidateIntake ticketIntake checkReports ticketDiagnose factGuard factGuardStore fixedSamples tavernAttribution requestLedger rewriteAttribution candidateStore evidenceGuard candidateApply candidateRef streamProtocol attributionChain creativeAttribution streamStall outputProtocol structuredOutputWire callAttribution lifecycleWiring contextManifest usageTruth requestBudget templatesWriteTargets templatesConsumers templatesDef templatesPlan templatesRender templatesMigrate templatesLibrary templatesLibraryOwner templatesMapping templatesLabels templatesFieldDefinition worldContextTemplate semanticView templatesCache templatesAdapter extractDetailed autoContinueSelfRefine aiAssist aiLongStream aiRouting aiTaskCenter aiTimeout auditFixes2 chapterOwned chapterRewrite chapterSnapshot companionRefresh companionStyle contextRank creativeModes creativeRun creativeWriting deAiStyle draftFields dynamicGuide errorLog evidencePack flowAliases flowDraft flowFieldMap flowFold flowFormMap flowParallelSummary flowPipeline fontPrefs freeVolume fullscreenShortcuts genreHint ghostStitch imagePortrait inspirationBlock inspirationFuse interviewContext knowledgeBase manuscriptCheck mapImage marketRadar miscSettings modelCapacity netPrefs optimizeTicket outlineBackfill paceAnalysis proofreadSplit readerProbe searchSettings styleFingerprint syncStatusMeta thinkPolicy trajectory uiPrefs userSystemPrompt versionCheck webSearch worldSets writerBudget writingPace aiRunLedger chapterPostProcess regenSummaries chapterAudit promptRegistry paceLockBands tavernTaskState interviewPersist settingLedgerMapping settingLedgerEquivalence ghostRename readSideGuard revisionStorage revisionCandidate q1q5 w4wt2 fullStack a1a3 a2c1 creativeProjectBoundary"

BATCH_D="adversarial backup backupPayloadSplit backupReminder blobMove bookEvidence bookbreak-ai-split bookbreakFormSummary bookbreakPersist bookbreakRecommend bookbreakRelations bookbreakResume bookbreakSplit chapterCheck cloudStoreWrapper crypto dataHealth dataDockView desktopSaveVerdict desktopSidecar diagnostics docxImport docxLayout exportPlatform ghostPrune idbMigrations legacySearchKey migrations perfBaseline portableBackend portableVecKb roundtrip seedRef semanticRecall syncConflicts syncTransport tableIO tableImportAI cardIO tavernAvatar tavernCardFields tavernCardFile tavernCardFold tavernContext tavernDaily tavernDraft tavernExportDoc tavernFlow tavernFree tavernImport tavernMemory tavernPostRules tavernPresets tavernPrompt tavernQuota tavernReady tavernRecall tavernReport tavernRevise tavernRoundEnd tavernScript tavernScriptSplit tavernSeedPolicy tavernSettings tavernStatus tavernStore tavernStory tavernStoryImport tavernUnload tavernUsage tavernVariant tavernVars tavernWorld tavernWorldBook webcrypto writingReview continuityFields checkLog modelFilter modelSampling jieWenJiAsk continuationPick syncPath syncRestore desktopWriteLock worldPack worlds worldImport runStore runTurn runWorldContext"

# ── 自检：批次名单 vs 实际测试文件 ──
# 双向查重，因为它们是**不同**的事故：
#   · GHOST     ＝名单里有、文件不在 ⇒ 打错名 / 文件被删（跑起来会当失败，浪费排查时间）
#   · UNBATCHED ＝文件在、名单里没有 ⇒ **静默漏跑**（汇总全绿，其实根本没测到它）
DECLARED="$BATCH_A $BATCH_B $BATCH_C $BATCH_D"
GHOST=""
SEEN=" "
DUPLICATES=""
for t in $DECLARED; do [ -f "tests/$t.test.ts" ] || GHOST="$GHOST $t"; done
for t in $DECLARED; do
  case "$SEEN" in *" $t "*) DUPLICATES="$DUPLICATES $t" ;; *) SEEN="$SEEN$t " ;; esac
done
UNBATCHED=""
for f in tests/*.test.ts; do
  t=$(basename "$f" .test.ts)
  case " $DECLARED " in *" $t "*) ;; *) UNBATCHED="$UNBATCHED $t" ;; esac
done
if [ -n "$GHOST" ]; then
  echo "⚠️ 批次名单里有不存在的入口（打错名或文件已删）：$GHOST" >&2
fi
if [ -n "$UNBATCHED" ]; then
  echo "🔴 有测试文件没归进任何批次，本次不会被跑到：$UNBATCHED" >&2
  echo "   ⇒ 请把它们加进上面某个 BATCH_x 列表（改完再跑一次确认）" >&2
fi
if [ -n "$DUPLICATES" ]; then
  echo "🔴 批次清单有重复入口，会被重复执行：$DUPLICATES" >&2
fi
if [ -n "$GHOST" ] || [ -n "$UNBATCHED" ] || [ -n "$DUPLICATES" ]; then
  echo "❌ 测试批次清单校验失败；已中止，修正名单后再运行。" >&2
  exit 1
fi

want=("$@")
[ ${#want[@]} -eq 0 ] && want=(all)
if [ "${want[0]}" = "all" ]; then want=(A B C D); fi

TOTAL_OK=0
TOTAL_BAD=0
FAILED=""
GLOBAL_T0=$SECONDS

for b in "${want[@]}"; do
  case "$b" in
    A) list="$BATCH_A" ;;
    B) list="$BATCH_B" ;;
    C) list="$BATCH_C" ;;
    D) list="$BATCH_D" ;;
    *) echo "❌ 未知批次「$b」（可选 A / B / C / D / all）" >&2; exit 1 ;;
  esac

  echo "════ 批次 $b ════"
  t0=$SECONDS
  n=0; ok=0; bad=0; badlist=""
  for t in $list; do
    n=$((n + 1))
    if "$NODE" tests/build-test.mjs "$t" >/dev/null 2>&1; then
      ok=$((ok + 1))
    else
      bad=$((bad + 1)); badlist="$badlist $t"
    fi
  done
  used=$((SECONDS - t0))
  if [ "$bad" -eq 0 ]; then
    echo "  ✅ $ok / $n 通过 · ${used}s"
  else
    echo "  ❌ $ok / $n 通过 · ${used}s"
    for t in $badlist; do
      echo "     FAIL $t"
      "$NODE" tests/build-test.mjs "$t" 2>&1 | grep -E '^\s*FAIL' | head -5 | sed 's/^/       /'
    done
  fi
  TOTAL_OK=$((TOTAL_OK + ok))
  TOTAL_BAD=$((TOTAL_BAD + bad))
  FAILED="$FAILED$badlist"
  echo
done

echo "════ 汇总 ════"
echo "  通过 $TOTAL_OK，失败 $TOTAL_BAD，总耗时 $((SECONDS - GLOBAL_T0))s"
if [ "$TOTAL_BAD" -gt 0 ]; then
  echo "  失败入口：$FAILED"
  exit 1
fi
echo "  ✅ 全绿"
