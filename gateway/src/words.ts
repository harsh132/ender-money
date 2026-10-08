/**
 * The words assigned names are built from: `<adjective>-<noun>-<100..999>`.
 * Ported unchanged from the old Ender Wallet (ender-backend apps/worker); a
 * pair too long for MAX_LABEL is simply never drawn (names.ts generateLabel).
 *
 * Curated, not scraped, because every one of these ends up in somebody's name.
 * A word is here only if it is:
 *
 *   - friendly or neutral on its own and beside any word from the other list —
 *     no bodies, illness, religion, politics, violence, alcohol or drugs, and
 *     nothing that doubles as slang or an insult (so no `pig`, `nut`, `cherry`);
 *   - spelled one way — no British/American pairs (`grey`, `harbour`, `yogurt`)
 *     and nothing people routinely misspell;
 *   - not a homophone of another word in either list (`pear`/`pair`), so a name
 *     read aloud cannot land on a different one;
 *   - 3 to 9 lowercase ASCII letters, so every name is a plain DNS label.
 *
 * Append-only once names are issued: a word that disappears leaves every name
 * built on it unassignable to anyone else, which is harmless, but a word that
 * changes spelling makes an existing name look misspelled. `words.test.ts`
 * checks the mechanical rules; the judgement ones are this comment.
 */

const list = (words: string): readonly string[] => words.trim().split(/\s+/);

export const ADJECTIVES = list(`
  able active adept adorable agile airy alert amazing amiable ample amused
  apt ardent artful artsy astute atomic avid awake aware awesome azure
  balmy beaming beloved blazing blissful blithe blue bold bonny bouncy
  brainy brave breezy bright brilliant brisk broad bubbly buoyant busy
  buttery calm candid canny capable careful caring casual charming cheerful
  cheery chic chipper chirpy choice chunky civil classic classy clean
  clear clever cloudy coastal cobalt comfy comic concise content cool
  cosmic courtly crafty creamy creative crimson crisp crunchy cuddly cultured
  curious curly cute cyan dainty dandy dapper daring darling dashing
  dazzling decent deft deluxe devoted dewy diligent direct dotted downy
  dreamy driven dutiful dynamic eager early earnest earthy easy elastic
  elated electric elegant elfin elite eloquent eminent enchanted endless
  energetic epic equal even exact excellent exotic expert exquisite fabled
  fabulous fair faithful famous fancy fantastic fast fearless feisty festive
  fiery fine first fit flashy flawless fleet flexible floral flowing fluent
  fluffy fluid flying focused folksy fond formal frank free fresh friendly
  frisky frosty fruity full funny fuzzy gallant galactic gauzy generous
  genial gentle genuine giant giddy gifted gilded glad glassy gleaming
  gleeful global glossy glowing golden good gourmet graceful gracious grand
  grassy grateful great green groovy gutsy handy happy hardy harmonic
  hearty helpful heroic hidden homey honest honeyed hopeful humble humming
  hushed icy ideal indigo inky intrepid inventive jaunty jazzy jolly jovial
  joyful joyous jubilant jumbo keen kind kindly kindred kinetic large lasting
  lavish leading leafy lemony level light limber little lively local lofty
  loving loyal lucid lucky lunar lush luminous lustrous magenta magical
  magnetic majestic major maroon marine mauve mellow melodic merry mighty
  mild milky mindful minty mirthful misty mobile modern modest molten
  moonlit mossy motley musical natural nautical neat nested nifty nimble
  noble nordic notable novel oceanic open orbital ornate pacific painted
  pastel patient peaceful peachy pearly pebbly peppy perfect perky petite
  placid playful pleasant pliant plucky plush poetic polar polished polite
  popular posh positive potent powdery precious precise pretty primal prime
  pristine prompt proper proud prudent puffy pure purple purring quaint
  quick quiet quirky radiant rainy rapid rare ready real refined regal
  regular relaxed reliable resilient restful retro rhythmic rich ripe
  rising roaming robust rolling roomy rosy rounded rousing royal rubbery
  rugged rural russet rustic salty sandy sassy savvy scarlet scenic secure
  sensible serene shaggy sharp shiny shrewd silent silky silver simple
  sincere skilled sleek sleepy slick smart smiley smoky smooth snappy
  snazzy snowy snug soaring social soft solar solid sonic sound sparkling
  sparky speedy spicy spiffy spirited splendid sporty spotless spotted
  spry spunky stable starry stately steady stellar still stoic stormy
  striped strong studious stunning sturdy stylish suave sublime subtle
  sugary sunlit sunny super superb supple supreme sure sweet swift tactful
  tall tangy tasty teal tender terrific thankful thrifty thriving tidal
  tidy timeless timely tinted tiny toasty tranquil treasured trendy trim
  tropic true trusted trusty tufted tuneful twinkly unique upbeat upright
  urban urbane useful valiant valid vast velvety verdant vernal vibrant
  vintage violet virtual vital vivid vocal warm wavy wealthy whimsical
  whole windy winged winsome wintry wise witty wondrous woody worldly
  worthy youthful zany zealous zestful zesty zippy
`);

export const NOUNS = list(`
  apple apricot avocado banana coconut date fig grape guava kiwi kumquat
  lemon lime lychee mango mandarin nectarine olive orange papaya pear
  pineapple plum pomelo quince raisin tangerine starfruit jackfruit durian
  rambutan longan feijoa loquat honeydew plantain satsuma yuzu mulberry
  cranberry raspberry

  artichoke arugula asparagus beet broccoli cabbage carrot celery chard
  chickpea corn cucumber endive fennel garlic ginger kale leek lentil
  lettuce okra onion parsnip pea pepper potato pumpkin radish rhubarb
  shallot spinach sprout squash tomato turnip yam zucchini kohlrabi edamame
  jicama taro cassava daikon scallion bean soybean

  basil cardamom cinnamon clove coriander cumin curry dill mint mustard
  nutmeg oregano paprika parsley rosemary saffron sage salt sesame sorrel
  tarragon turmeric vanilla wasabi chive anise caraway sumac harissa pesto
  salsa relish chutney vinegar honey syrup molasses maple

  bagel baguette biscuit brownie bun burrito butter cake candy caramel
  cheese cobbler cookie cracker crepe croissant cupcake custard dumpling
  falafel fudge gelato granola gravy hummus jam jelly latte meringue mochi
  muesli nacho noodle oatmeal pancake pasta pastry pie pizza popcorn
  porridge pretzel pudding quiche ramen ravioli risotto salad sandwich scone
  sorbet soup strudel sushi taco tamale toast toffee tofu tortilla truffle
  waffle wafer dosa naan samosa biryani crumble crouton flan baklava churro
  tiramisu brioche biscotti praline nougat marzipan lollipop gumdrop pickle

  cocoa coffee juice lemonade smoothie soda tea chai matcha espresso mocha
  sherbet milkshake

  alpaca antelope armadillo badger bear bison bobcat buffalo bunny camel
  capybara caribou cat chipmunk coyote deer dingo dolphin elephant elk
  ferret fox gazelle gecko gerbil giraffe gopher hamster hedgehog hippo
  horse ibex iguana impala jaguar kangaroo koala lemur leopard lion llama
  marmot meerkat mink moose mouse mustang narwhal ocelot okapi otter panda
  panther pony puma quokka rabbit raccoon reindeer rhino seal sloth
  squirrel stoat tapir tiger walrus wallaby wolf wombat yak zebra kitten
  puppy lamb foal fawn cub colt

  albatross bluebird canary condor crane crow dove duck eagle egret emu
  falcon finch flamingo gannet gull hawk heron ibis jay kestrel lark macaw
  magpie mallard merlin oriole osprey ostrich owl parrot partridge pelican
  penguin petrel pigeon plover puffin quail raven robin rooster skylark
  sparrow starling stork swan tern toucan warbler wren budgie lovebird
  hoopoe avocet sunbird

  anchovy barnacle clam coral crab eel jellyfish krill lobster manatee
  marlin minnow octopus orca oyster prawn salmon sardine scallop seahorse
  shrimp snapper squid starfish stingray sturgeon trout tuna urchin whale
  halibut herring mackerel cod guppy koi sponge turtle tortoise beluga dugong

  ant bee beetle butterfly cicada cricket dragonfly firefly honeybee
  ladybug mantis moth snail bumblebee frog newt chameleon axolotl lizard

  acorn alder aloe aspen azalea bamboo banyan baobab begonia birch blossom
  bluebell bonsai cactus camellia cedar clover crocus cypress daffodil
  dahlia daisy dandelion elm fern ficus foxglove gardenia geranium hazel
  heather hibiscus holly hyacinth iris ivy jasmine juniper larch laurel
  lavender lilac lily lotus magnolia marigold mimosa moss myrtle oak orchid
  peony petunia pine poppy primrose redwood reed rose sequoia spruce
  sunflower sycamore thistle tulip willow wisteria yarrow zinnia acacia
  bramble shamrock poplar walnut almond cashew chestnut pecan pistachio
  peanut

  aurora beach boulder breeze brook canyon cascade cave cliff cloud comet
  coast cosmos cove crater creek dawn delta dew dune dusk eclipse ember
  equinox estuary field fjord fog forest fountain frost galaxy geyser
  glacier glade glen grove gulf haze hill horizon island jungle lagoon lake
  lava meadow mesa meteor mist moon nebula oasis ocean orbit pebble planet
  plateau pond prairie puddle quasar rain rainbow reef ridge river rock
  shore sky slope snow spring star storm stream summit sun sunrise sunset
  thunder tide tundra twilight valley volcano wave wind zenith zephyr
  stardust snowflake monsoon drizzle marsh bayou atoll cavern grotto nova
  pulsar asteroid supernova

  agate amber amethyst basalt bronze copper diamond emerald garnet gold
  granite graphite jade jasper marble nickel obsidian onyx opal pearl
  pewter platinum quartz ruby sapphire silk slate steel tin titanium topaz
  turquoise zircon velvet satin linen cotton wool denim tweed cashmere
  flannel lace suede canvas cork clay glass paper timber chrome iron zinc
  mica flint chalk

  accordion banjo bell bongo bugle cello chime clarinet drum fiddle flute
  gong guitar harp harmonica kazoo mandolin marimba oboe piano piccolo sitar
  tabla trumpet tuba ukulele viola violin xylophone melody rhythm sonata
  tempo chorus ballad lyric tune jingle whistle harmony

  anchor anvil apron atlas badge balloon basket beacon blanket bottle bucket
  button cabin candle canoe carpet castle clock compass cradle crayon crown
  cup cushion desk dial dome easel engine fan feather flag flask gadget
  garden gate globe goblet hammock helmet hive jar jigsaw kettle key kite
  ladder lamp lantern latch lens locket magnet map mask mitten mirror mug
  napkin notebook oar paddle parasol pencil pillow pinwheel pitcher pocket
  pouch prism pulley puzzle quill quilt radio raft ribbon rocket rope rudder
  saddle sail satchel scarf scroll shovel sled slipper spoon spool stamp
  statue sundial swing table teapot thimble ticket tile torch tower toy
  trophy tunnel umbrella vase wagon wallet wand window zipper pendant eraser
  ruler stapler marker sticker stencil backpack lanyard locker bench cabinet
  drawer shelf sofa armchair rug curtain teacup saucer ladle whisk spatula
  colander skillet griddle toaster blender oven fridge mixer grater sieve
  tray bowl plate jug carafe thermos lunchbox matchbox igloo tent hut
  bridge chimney cottage gazebo pagoda pavilion pyramid turret attic
  balcony porch patio terrace orchard barn silo pier dock wharf jetty
  marina canal windmill

  airship bicycle blimp boat buggy bus caravan cart chariot ferry glider
  gondola kayak sailboat scooter shuttle submarine tandem taxi tractor train
  tram trolley truck unicycle van yacht zeppelin jet rover satellite
  telescope

  chess dice domino hoop puppet doll robot block confetti bubble
  glitter rattle seesaw teddy tennis golf rugby hockey judo

  arc circle cube cone spiral pixel sphere triangle helix ripple echo spark
  beam flame glimmer shadow whisper riddle rhyme poem story fable saga
  sonnet haiku verse letter

  beret bonnet boot cap cape cardigan cloak coat gown glove hat jacket
  jersey kimono parka poncho robe sandal shawl sneaker sock sweater toga
  tunic tuxedo vest hoodie beanie

  paella polenta couscous quinoa pierogi gyoza tempura udon soba bento
  onigiri kimchi miso tahini pakora idli kulfi lassi jalebi parfait gumbo
  stew broth chowder bisque fondue taffy jellybean cornbread flapjack

  aardvark anteater beagle poodle terrier collie corgi spaniel bulldog pug
  tabby calico pika vole unicorn dragon phoenix pegasus sphinx bittern
  bunting curlew dipper dunlin grebe hornbill jackdaw lapwing linnet
  pheasant quetzal siskin tanager towhee kakapo kea cassowary

  grouper kelp lionfish nautilus perch shark sunfish tarpon seaweed
  plankton conch whelk abalone limpet sprat bream

  aster buttercup carnation cyclamen edelweiss freesia hydrangea lantana
  lobelia oleander protea verbena yucca agave hawthorn hickory linden
  mangrove rowan teak tamarind catkin conifer sapling seedling petal leaf
  twig branch vine lichen mushroom morel

  abacus album amulet baton beanbag bobbin bookend bookmark bracelet broom
  cable calendar camera canister carousel cauldron charm coaster crate
  cupboard diary doorbell envelope frame funnel hanger headband hourglass
  journal keychain lasso lectern magazine mailbox mallet medal megaphone
  metronome mosaic necklace notepad ornament padlock palette passport pedal
  pinecone planter postcard scrapbook seashell signpost spyglass suitcase
  tablet tassel tiara toolbox trinket trellis trowel wheel zither

  alcove arcade avenue bakery bazaar bistro bungalow campus chalet
  courtyard diner gallery kiosk library lodge market museum pantry plaza
  ranch studio village workshop cabana hamlet manor villa yurt treehouse

  cirrus nimbus gust sleet squall sunbeam moonbeam starlight daybreak
  sundown riverbank seashore waterfall pinnacle bluff knoll spire cairn
  geode fossil magma sandbar
`);
