import { App, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type { RecipeRefTarget } from '../utils/ingredientAggregator';
import { resolveReferenceCandidatePaths } from '../utils/recipeReferences';
import { isRecipeFile } from '../utils/recipeFiles';
import type {
    RecipeHostAdapter,
    ResolvedRecipeReference,
} from './types';

export class ObsidianRecipeHost implements RecipeHostAdapter {
    constructor(
        private app: App,
        private onOpenRecipe?: (leaf: WorkspaceLeaf, reference: ResolvedRecipeReference) => void,
        private onEditTags?: (file: TFile) => void,
    ) {}

    editTags(file: TFile): void {
        this.onEditTags?.(file);
    }

    getResourcePath(file: TFile): string {
        return this.app.vault.getResourcePath(file);
    }

    resolveReference(
        sourceFile: TFile | null,
        ref: RecipeRefTarget,
    ): ResolvedRecipeReference | null {
        const candidates = resolveReferenceCandidatePaths(
            '',
            ref.components ?? [],
            ref.name,
        );
        const target = candidates.map(path => this.app.vault.getAbstractFileByPath(path))
            .find((file): file is TFile => file instanceof TFile
                && isRecipeFile(file.path, this.app.metadataCache.getFileCache(file)?.frontmatter));

        return target
            ? {
                targetPath: target.path,
                sourcePath: sourceFile?.path ?? '',
                scaleRequest: ref.quantity !== null && ref.quantity > 0
                    ? { quantity: ref.quantity, unit: ref.unit }
                    : null,
            }
            : null;
    }

    openReference(reference: ResolvedRecipeReference): void {
        const leaf = this.app.workspace.getLeaf(false);
        if (this.onOpenRecipe) {
            this.onOpenRecipe(leaf, reference);
            return;
        }
        void leaf.setViewState({
            type: 'cook',
            state: {
                file: reference.targetPath,
                mode: 'preview',
                referenceScale: reference.scaleRequest,
            },
        });
    }

    openWikiLink(sourcePath: string, linktext: string): void {
        void this.app.workspace.openLinkText(linktext, sourcePath);
    }

    resolveLink(linktext: string, sourcePath: string): TFile | null {
        const file = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
        return file instanceof TFile ? file : null;
    }

    async setRecipeMark(file: TFile, key: 'favorite' | 'rating', value: boolean | number): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
            if (value) frontmatter[key] = value;
            else delete frontmatter[key];
        });
    }

    searchTag(tag: string): void {
        // The core Search plugin has no public API; this is how other plugins open it with a query.
        const search = (this.app as unknown as { internalPlugins?: { getPluginById?(id: string): { enabled?: boolean; instance?: { openGlobalSearch?(query: string): void } } | undefined } })
            .internalPlugins?.getPluginById?.('global-search');
        if (search?.enabled && search.instance?.openGlobalSearch) search.instance.openGlobalSearch(`tag:#${tag}`);
        else new Notice('Turn on the Search core plugin to search by tag.');
    }
}
