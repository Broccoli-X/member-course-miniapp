Page({
  data: {
    courses: [] as Array<{ id: string; name: string; description: string }>,
    loading: false,
  },
  onLoad() {
    this.setData({ courses: [] });
  },
});
