<script lang="ts">
    import { findRecipeImages } from '../utils/imageHelpers';
    import { getRecipeImageUrls } from '../utils/recipeImages';
    import { photoLinkText } from '../utils/recipeMarks';
    import CookwareList from './components/CookwareList.svelte';
    import Hero from './components/Hero.svelte';
    import IngredientList from './components/IngredientList.svelte';
    import Metadata from './components/Metadata.svelte';
    import MethodSteps from './components/MethodSteps.svelte';
    import ScalerBar from './components/ScalerBar.svelte';
    import TimerList from './components/TimerList.svelte';
    import type { RecipeRenderModel } from './types';

    let { model }: { model: RecipeRenderModel } = $props();
    let images = $derived(findRecipeImages(model.file));
    // A photo beside the recipe wins; otherwise the one its `photo` property links to (for example in a
    // Photos folder); otherwise an `image:` web address.
    let linkedPhoto = $derived.by(() => {
        const link = photoLinkText(model.recipe);
        return link && model.file && model.host.resolveLink ? model.host.resolveLink(link, model.file.path) : null;
    });
    let mainImage = $derived(images.mainImage ?? linkedPhoto ?? getRecipeImageUrls(model.recipe.images)[0] ?? null);
</script>

<Hero {model} {mainImage} />
<ScalerBar {model} />

<div class:cook-cols-stacked={!model.settings.twoColumnLayout} class="cook-cols">
    <aside class="cook-aside" aria-label="Recipe ingredients and equipment">
        <IngredientList {model} />
        <CookwareList {model} />
        <TimerList {model} />
    </aside>
    <main class="cook-main">
        <MethodSteps {model} allImages={images.allImages} />
    </main>
</div>

<Metadata {model} />
