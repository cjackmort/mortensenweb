# Images

Photographs and logos the client has sent for use on their site. Referenced
from the markup as `/images/<filename>`, since `src/` is copied to the site
root at build time.

## For whoever adds them

Name files for what they show, not what they are:

```
crew-outside-shop.jpg        good
kitchen-remodel-after.jpg    good
IMG_4471.jpg                 bad
photo1.jpg                   bad
```

The filename is the main clue an agent has about what an image contains, and
it is what decides whether a request like *"put the one of the van on the
services page"* can be satisfied without asking.

Resize before committing. A photo straight from a phone is often 4–6 MB, which
is several seconds of load on a rural mobile connection — the exact visitor a
local trade site cannot afford to lose. 1600px on the long edge is plenty.

## For the agent

**Only use images that are in this folder.** Do not link to an image on the
client's old website, on a stock photography site, or at any other external
URL. Those links break, they may not be licensed for this use, and a broken
image on a live business site is worse than no image.

If a request asks for a photo that is not here, say so in the pull request
rather than substituting something. The operator will add it.

Every `<img>` needs an `alt` describing what is shown. It is what a screen
reader announces, what search engines read, and what appears if the image
fails to load. `alt=""` is correct only for decoration that adds nothing.
