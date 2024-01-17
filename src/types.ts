export type AlbumProps = {
  name: string;
  artist: string;
  codes: string[];
  image: string;
  link: string;
};

export type ArtistProps = {
  uid: string;
  name: string;
  location: string;
  releases: AlbumProps[];
};

export type AvatarProps = {
  user: any;
  handleLogout: () => void;
};