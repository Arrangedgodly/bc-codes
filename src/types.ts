export type AlbumProps = {
  name: string;
  artist: string;
  codes: string[];
  image: string;
  link: string;
};

export type ArtistProps = {
  name: string;
  location: string;
  releases: AlbumProps[];
};

export type AvatarProps = {
  user: any;
  handleLogout: () => void;
};